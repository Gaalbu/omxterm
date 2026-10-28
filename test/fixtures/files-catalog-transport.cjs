// Test-only TLS origin behind exact-URL interception, never application code.
// This qualifies packaged transport composition, not GitHub/public TLS delivery.
const https = require("node:https");
const { readFile } = require("node:fs/promises");
const { syncBuiltinESMExports } = require("node:module");
const assert = require("node:assert/strict");
const catalogUrl =
  "https://raw.githubusercontent.com/luizomf/omxterm/main/distribution/official-extensions-v1.json";

async function start(options) {
  const catalog = JSON.parse(await readFile(options.catalogFile, "utf8"));
  assert.equal(catalog.entries.length, 1);
  const entry = catalog.entries[0];
  assert.equal(entry.archive.sha256, options.archiveSha256);
  const archive = await readFile(options.archive);
  const requests = [];
  let catalogAvailable = false;
  let archiveValid = false;
  const ca = await readFile(options.catalogCertificate);
  const server = https.createServer(
    { cert: ca, key: await readFile(options.catalogKey) },
    (request, response) => {
      requests.push(request.url);
      if (request.url === "/catalog") {
        response.writeHead(catalogAvailable ? 200 : 503);
        response.end(
          catalogAvailable ? JSON.stringify(catalog) : "offline fixture",
        );
      } else if (request.url === "/archive") {
        response.writeHead(200);
        response.end(archiveValid ? archive : Buffer.from("wrong bytes"));
      } else {
        response.writeHead(404);
        response.end();
      }
    },
  );
  const sockets = new Set();
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const origin = `https://127.0.0.1:${server.address().port}`;
  const original = https.request;
  const routed = (url, settings, callback) => {
    const value = String(url);
    const route =
      value === catalogUrl
        ? "/catalog"
        : value === entry.archive.url
          ? "/archive"
          : undefined;
    assert.ok(route, "controlled catalog lane must not contact another origin");
    return original(new URL(origin + route), { ...settings, ca }, callback);
  };
  https.request = routed;
  syncBuiltinESMExports();
  let closed = false;
  return {
    requests,
    available(value) {
      catalogAvailable = value;
    },
    validArchive(value) {
      archiveValid = value;
    },
    offeredVersion(value) {
      entry.version = value;
    },
    async close() {
      if (closed) return;
      closed = true;
      assert.equal(https.request, routed);
      https.request = original;
      syncBuiltinESMExports();
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
      assert.equal(server.listening, false);
    },
  };
}
module.exports = { start };
