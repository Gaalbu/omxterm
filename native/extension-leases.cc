// Node-API 8 only: every filesystem operation runs on the worker pool.
#include <node_api.h>
#include <atomic>
#include <string>
#ifdef _WIN32
#define NOMINMAX
#include <windows.h>
#else
#include <cerrno>
#include <fcntl.h>
#include <sys/file.h>
#include <sys/stat.h>
#include <unistd.h>
#endif

namespace {
constexpr unsigned kCapacity = 128;
std::atomic<unsigned> admitted{0};
constexpr napi_type_tag kLeaseTag{0x8a3019bc65e4fd72ULL, 0xa61b7f239d08c452ULL};
struct Lease {
  napi_env env;
  napi_async_work acquire = nullptr, cleanup = nullptr;
  napi_async_cleanup_hook_handle hook = nullptr;
  napi_deferred acquisition = nullptr, release = nullptr;
  napi_ref reference = nullptr;
  std::string path;
  bool exclusive = false, busy = false, pending = true, closing = false;
  bool closed = false, finalized = false, teardown = false;
  const char* error = nullptr;
#ifdef _WIN32
  HANDLE handle = INVALID_HANDLE_VALUE;
#else
  int handle = -1;
#endif
};

napi_value Error(napi_env env, const char* code) {
  napi_value text, error;
  if (napi_create_string_utf8(env, code, NAPI_AUTO_LENGTH, &text) != napi_ok ||
      napi_create_error(env, text, text, &error) != napi_ok) return nullptr;
  return error;
}
void Check(napi_status status) {
  // Continuing after a failed lifetime bookkeeping operation could leak a lock.
  if (status != napi_ok) napi_fatal_error("extension-leases", NAPI_AUTO_LENGTH,
                                         "LEASE_RUNTIME", NAPI_AUTO_LENGTH);
}
void Close(Lease* lease) {
#ifdef _WIN32
  if (lease->handle != INVALID_HANDLE_VALUE) {
    OVERLAPPED position{};
    if (!UnlockFileEx(lease->handle, 0, 1, 0, &position) && !lease->error)
      lease->error = "LEASE_RELEASE";
    if (!CloseHandle(lease->handle) && !lease->error) lease->error = "LEASE_CLOSE";
    lease->handle = INVALID_HANDLE_VALUE;
  }
#else
  if (lease->handle >= 0) {
    int result;
    do { result = flock(lease->handle, LOCK_UN); } while (result < 0 && errno == EINTR);
    if (result < 0 && !lease->error) lease->error = "LEASE_RELEASE";
    // Never retry close: a reused descriptor must not be closed accidentally.
    if (close(lease->handle) < 0 && !lease->error) lease->error = "LEASE_CLOSE";
    lease->handle = -1;
  }
#endif
}
void AcquireExecute(napi_env, void* data) {
  auto* lease = static_cast<Lease*>(data);
#ifdef _WIN32
  int length = MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, lease->path.data(),
                                  static_cast<int>(lease->path.size()), nullptr, 0);
  if (!length) { lease->error = "LEASE_PATH"; return; }
  std::wstring path(length, L'\0');
  MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, lease->path.data(),
                      static_cast<int>(lease->path.size()), path.data(), length);
  lease->handle = CreateFileW(path.c_str(), GENERIC_READ | GENERIC_WRITE,
      FILE_SHARE_READ | FILE_SHARE_WRITE, nullptr, OPEN_ALWAYS,
      FILE_FLAG_OPEN_REPARSE_POINT | FILE_FLAG_BACKUP_SEMANTICS, nullptr);
  if (lease->handle == INVALID_HANDLE_VALUE) { lease->error = "LEASE_OPEN"; return; }
  FILE_ATTRIBUTE_TAG_INFO attributes{};
  if (!GetFileInformationByHandleEx(lease->handle, FileAttributeTagInfo,
                                    &attributes, sizeof(attributes)) ||
      GetFileType(lease->handle) != FILE_TYPE_DISK ||
      (attributes.FileAttributes & (FILE_ATTRIBUTE_REPARSE_POINT | FILE_ATTRIBUTE_DIRECTORY))) {
    lease->error = "LEASE_OBJECT";
  } else {
    OVERLAPPED position{};
    DWORD flags = LOCKFILE_FAIL_IMMEDIATELY | (lease->exclusive ? LOCKFILE_EXCLUSIVE_LOCK : 0);
    if (!LockFileEx(lease->handle, flags, 0, 1, 0, &position)) {
      if (GetLastError() == ERROR_LOCK_VIOLATION) lease->busy = true;
      else lease->error = "LEASE_LOCK";
    }
  }
#else
  lease->handle = open(lease->path.c_str(), O_CREAT | O_RDWR | O_CLOEXEC | O_NOFOLLOW | O_NONBLOCK, 0600);
  if (lease->handle < 0) { lease->error = errno == ELOOP ? "LEASE_OBJECT" : "LEASE_OPEN"; return; }
  struct stat stat{};
  if (fstat(lease->handle, &stat) < 0 || !S_ISREG(stat.st_mode)) {
    lease->error = "LEASE_OBJECT";
  } else {
    int result;
    do { result = flock(lease->handle, (lease->exclusive ? LOCK_EX : LOCK_SH) | LOCK_NB); }
    while (result < 0 && errno == EINTR);
    if (result < 0) {
      if (errno == EWOULDBLOCK || errno == EAGAIN) lease->busy = true;
      else lease->error = "LEASE_LOCK";
    }
  }
#endif
  if (lease->error || lease->busy) {
    // Closing an unlocked handle is sufficient; do not report unlock errors on contention.
#ifdef _WIN32
    if (!CloseHandle(lease->handle)) lease->error = "LEASE_CLOSE";
    lease->handle = INVALID_HANDLE_VALUE;
#else
    if (close(lease->handle) < 0) lease->error = "LEASE_CLOSE";
    lease->handle = -1;
#endif
  }
}
void CleanupExecute(napi_env, void* data) { Close(static_cast<Lease*>(data)); }
void StartCleanup(Lease* lease) {
  if (lease->pending || lease->closing || lease->closed) return;
  lease->closing = true;
  Check(napi_queue_async_work(lease->env, lease->cleanup));
}
void Finalize(napi_env, void* data, void*) {
  auto* lease = static_cast<Lease*>(data);
  lease->finalized = true;
  if (lease->closed) delete lease;
  else StartCleanup(lease);
}
void Teardown(napi_async_cleanup_hook_handle, void* data) {
  auto* lease = static_cast<Lease*>(data);
  lease->teardown = true;
  StartCleanup(lease);
}
void CleanupComplete(napi_env env, napi_status status, void* data) {
  auto* lease = static_cast<Lease*>(data);
  Check(status);
  lease->closed = true;
  --admitted;
  Check(napi_delete_async_work(env, lease->cleanup));
  Check(napi_remove_async_cleanup_hook(lease->hook));
  if (lease->release && !lease->teardown) {
    napi_value value;
    if (lease->error) {
      value = Error(env, lease->error);
      if (value) napi_reject_deferred(env, lease->release, value);
    } else if (napi_get_undefined(env, &value) == napi_ok) {
      napi_resolve_deferred(env, lease->release, value);
    }
  }
  if (lease->reference) {
    Check(napi_delete_reference(env, lease->reference));
    lease->reference = nullptr;
  }
  if (lease->finalized) delete lease;
}
void AcquireComplete(napi_env env, napi_status status, void* data) {
  auto* lease = static_cast<Lease*>(data);
  lease->pending = false;
  Check(napi_delete_async_work(env, lease->acquire));
  // A terminating Worker can drain completions before async cleanup hooks run.
  // It no longer permits JS settlement; retain ownership until worker-side close.
  if (status != napi_ok) lease->teardown = true;
  if (lease->teardown) { StartCleanup(lease); return; }
  napi_value value;
  napi_status settled;
  if (lease->error) {
    value = Error(env, lease->error);
    settled = value ? napi_reject_deferred(env, lease->acquisition, value) : napi_closing;
  } else {
    settled = lease->busy ? napi_get_null(env, &value)
                         : napi_get_reference_value(env, lease->reference, &value);
    if (settled == napi_ok) settled = napi_resolve_deferred(env, lease->acquisition, value);
  }
  if (settled != napi_ok) lease->teardown = true;
  if (lease->teardown || lease->error || lease->busy) StartCleanup(lease);
  else {
    Check(napi_delete_reference(env, lease->reference));
    lease->reference = nullptr;
  }
}
napi_value Acquire(napi_env env, napi_callback_info info) {
  napi_value args[2], promise;
  size_t argc = 2, length = 0;
  Check(napi_get_cb_info(env, info, &argc, args, nullptr, nullptr));
  napi_deferred deferred;
  Check(napi_create_promise(env, &deferred, &promise));
  bool exclusive;
  if (argc != 2 || napi_get_value_string_utf8(env, args[0], nullptr, 0, &length) != napi_ok ||
      length == 0 || length > 32768 || napi_get_value_bool(env, args[1], &exclusive) != napi_ok) {
    napi_reject_deferred(env, deferred, Error(env, "LEASE_PATH")); return promise;
  }
  if (admitted.fetch_add(1) >= kCapacity) {
    --admitted;
    napi_reject_deferred(env, deferred, Error(env, "LEASE_CAPACITY")); return promise;
  }
  auto* lease = new Lease{};
  lease->env = env;
  lease->acquisition = deferred;
  lease->exclusive = exclusive;
  lease->path.resize(length + 1);
  Check(napi_get_value_string_utf8(env, args[0], lease->path.data(), length + 1, &length));
  lease->path.resize(length);
  if (lease->path.find('\0') != std::string::npos) {
    --admitted; delete lease;
    napi_reject_deferred(env, deferred, Error(env, "LEASE_PATH")); return promise;
  }
  napi_value token, name;
  Check(napi_create_object(env, &token));
  Check(napi_type_tag_object(env, token, &kLeaseTag));
  Check(napi_wrap(env, token, lease, Finalize, nullptr, nullptr));
  Check(napi_create_reference(env, token, 1, &lease->reference));
  Check(napi_create_string_utf8(env, "extension-leases", NAPI_AUTO_LENGTH, &name));
  Check(napi_create_async_work(env, nullptr, name, AcquireExecute, AcquireComplete, lease, &lease->acquire));
  Check(napi_create_async_work(env, nullptr, name, CleanupExecute, CleanupComplete, lease, &lease->cleanup));
  Check(napi_add_async_cleanup_hook(env, Teardown, lease, &lease->hook));
  Check(napi_queue_async_work(env, lease->acquire));
  return promise;
}
napi_value Release(napi_env env, napi_callback_info info) {
  napi_value token, promise;
  size_t argc = 1;
  Check(napi_get_cb_info(env, info, &argc, &token, nullptr, nullptr));
  Lease* lease = nullptr;
  bool tagged = false;
  if (argc != 1 || napi_check_object_type_tag(env, token, &kLeaseTag, &tagged) != napi_ok ||
      !tagged || napi_unwrap(env, token, reinterpret_cast<void**>(&lease)) != napi_ok) {
    napi_throw_error(env, "LEASE_TOKEN", "LEASE_TOKEN"); return nullptr;
  }
  napi_deferred deferred;
  Check(napi_create_promise(env, &deferred, &promise));
  if (lease->closed) {
    napi_value value; napi_get_undefined(env, &value);
    napi_resolve_deferred(env, deferred, value);
  } else if (lease->closing) {
    napi_reject_deferred(env, deferred, Error(env, "LEASE_STATE"));
  } else {
    lease->release = deferred;
    Check(napi_create_reference(env, token, 1, &lease->reference));
    StartCleanup(lease);
  }
  return promise;
}
napi_value Init(napi_env env, napi_value exports) {
  napi_property_descriptor properties[] = {
    {"tryAcquire", nullptr, Acquire, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"release", nullptr, Release, nullptr, nullptr, nullptr, napi_default, nullptr},
  };
  Check(napi_define_properties(env, exports, 2, properties));
  return exports;
}
}  // namespace
NAPI_MODULE(NODE_GYP_MODULE_NAME, Init)
