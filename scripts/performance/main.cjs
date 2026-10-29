const { app, BrowserWindow } = require("electron");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const control = process.argv.includes("--performance-control");
for (const name of ["userData", "sessionData"]) {
  const directory = path.join(__dirname, name);
  fs.mkdirSync(directory, { recursive: true });
  app.setPath(name, directory);
}
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const deadline = setTimeout(() => app.exit(2), 60000);
app
  .whenReady()
  .then(async () => {
    const window = new BrowserWindow({
      width: 800,
      height: 500,
      useContentSize: true,
      show: false,
      webPreferences: {
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        webSecurity: true,
        backgroundThrottling: false,
      },
    });
    await window.loadFile(path.join(__dirname, "index.html"));
    window.showInactive();
    const evaluate = (expression) =>
      window.webContents.executeJavaScript(expression, true);
    const snapshot = () => ({
      timeMs: performance.now(),
      processes: app
        .getAppMetrics()
        .map(({ pid, type, creationTime, cpu, memory }) => ({
          pid,
          type,
          creationTime,
          cpuSeconds: cpu.cumulativeCPUUsage,
          workingSetKiB: memory.workingSetSize,
        })),
    });
    await evaluate("performanceFixture.ready");
    const phases = [];
    for (const [name, count] of [
      ["one", 1],
      ["three", 3],
      ["closed", 1],
    ]) {
      const before = snapshot();
      const rendering = await evaluate(
        `performanceFixture.phase(${count}, ${control})`,
      );
      const after = snapshot();
      // Fixed post-workload samples retain high-water marks; no forced GC.
      const samples = [after];
      for (let index = 0; index < 3; index++) {
        await delay(1000);
        if (control) await evaluate("performanceFixture.controlCpu()");
        samples.push(snapshot());
      }
      phases.push({ name, rendering, before, samples });
    }
    const result = {
      versions: process.versions,
      platform: process.platform,
      arch: process.arch,
      release: os.release(),
      cpu: os.cpus()[0]?.model,
      logicalCpus: os.cpus().length,
      totalMemoryBytes: os.totalmem(),
      loadAverage: os.loadavg(),
      gpu: await app.getGPUInfo("basic"),
      contentBounds: window.getContentBounds(),
      phases,
    };
    await evaluate("performanceFixture.dispose()");
    window.destroy();
    clearTimeout(deadline);
    process.stdout.write(
      "__OMXTERM_PERFORMANCE__" + JSON.stringify(result) + "\n",
    );
    app.exit(0);
  })
  .catch((error) => {
    console.error(error);
    app.exit(1);
  });
