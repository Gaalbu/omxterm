// Resolve the node.exe import library against the current Node/Electron image.
// Delay loading avoids a hard dependency on an executable named node.exe.
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <delayimp.h>
#include <cstring>

namespace {
FARPROC WINAPI LoadRuntime(unsigned notification, DelayLoadInfo* info) {
  if (notification != dliNotePreLoadLibrary ||
      _stricmp(info->szDll, "node.exe") != 0) return nullptr;
  return reinterpret_cast<FARPROC>(GetModuleHandleW(nullptr));
}
}  // namespace

decltype(__pfnDliNotifyHook2) __pfnDliNotifyHook2 = LoadRuntime;
