import { cp, mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { prepareFixture, type FixtureCleanupOwner } from "./prepare-fixture";

const projectRoot = fileURLToPath(new URL("../..", import.meta.url));
export async function buildFixture(
  root: string,
  cleanupOwner: FixtureCleanupOwner = "recipe",
  control: "current" | "old-post-read" = "current",
) {
  return prepareFixture(
    root,
    async (start) => {
      await mkdir(path.join(root, "renderer"));
      await Promise.all([
        start(() =>
          build({
            absWorkingDir: projectRoot,
            bundle: true,
            entryPoints: ["test/fixtures/font-read-reload-main.ts"],
            external: ["electron", "node-pty"],
            format: "cjs",
            platform: "node",
            logLevel: "silent",
            outfile: path.join(root, "main.cjs"),
            plugins: [
              {
                name: "hold-actual-native-font-read",
                setup(builder) {
                  if (control === "old-post-read")
                    builder.onLoad(
                      { filter: /terminal-font-data-request\.ts$/ },
                      async (args) => {
                        const source = await readFile(args.path, "utf8");
                        const current =
                          'if (options.isDisposed())\n          throw new Error("Terminal Font request was superseded");';
                        if (!source.includes(current))
                          throw new Error("Post-read mutation target changed");
                        return {
                          loader: "ts",
                          contents: source.replace(
                            current,
                            'if (options.isDisposed() || options.family() !== family || options.generation() !== generation)\n          throw new Error("Terminal Font request was superseded");',
                          ),
                        };
                      },
                    );
                  builder.onResolve(
                    { filter: /^node:fs\/promises$/ },
                    (args) =>
                      args.importer ===
                      path.join(
                        projectRoot,
                        "src/main/installed-font-family.ts",
                      )
                        ? {
                            path: path.join(
                              projectRoot,
                              "test/fixtures/font-read-reload-io.ts",
                            ),
                          }
                        : undefined,
                  );
                },
              },
            ],
          }),
        ),
        start(() =>
          build({
            absWorkingDir: projectRoot,
            bundle: true,
            entryPoints: ["src/preload/index.ts"],
            external: ["electron"],
            format: "cjs",
            platform: "node",
            logLevel: "silent",
            outfile: path.join(root, "preload.cjs"),
          }),
        ),
        start(() =>
          build({
            absWorkingDir: projectRoot,
            bundle: true,
            entryPoints: ["test/fixtures/font-read-reload-renderer.ts"],
            format: "iife",
            platform: "browser",
            loader: { ".ttf": "binary" },
            logLevel: "silent",
            outfile: path.join(root, "renderer/index.js"),
            plugins: [
              {
                name: "observe-real-font-reload-surfaces",
                setup(builder) {
                  builder.onResolve(
                    { filter: /electron-terminal-adapter$/ },
                    (args) =>
                      args.importer ===
                      path.join(
                        projectRoot,
                        "src/renderer/start-terminal-window.ts",
                      )
                        ? {
                            path: path.join(
                              projectRoot,
                              "test/fixtures/font-read-reload-adapter.ts",
                            ),
                          }
                        : undefined,
                  );
                  builder.onResolve(
                    { filter: /restty-terminal-surface$/ },
                    (args) =>
                      args.importer ===
                      path.join(
                        projectRoot,
                        "src/renderer/start-terminal-window.ts",
                      )
                        ? {
                            path: path.join(
                              projectRoot,
                              "test/fixtures/font-read-reload-surface.ts",
                            ),
                          }
                        : undefined,
                  );
                },
              },
            ],
          }),
        ),
        start(() =>
          cp(
            path.join(projectRoot, "src/renderer/index.html"),
            path.join(root, "renderer/index.html"),
          ),
        ),
        start(() =>
          symlink(
            path.join(projectRoot, "node_modules"),
            path.join(root, "node_modules"),
            "dir",
          ),
        ),
        start(() =>
          writeFile(
            path.join(root, "package.json"),
            JSON.stringify({
              name: "omxterm-font-read-reload-fixture",
              main: "main.cjs",
            }),
          ),
        ),
      ]);
    },
    cleanupOwner,
  );
}
