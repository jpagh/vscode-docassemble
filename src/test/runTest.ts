import * as path from "node:path";
import { existsSync, readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";

import {
  runTests,
  downloadAndUnzipVSCode,
  resolveCliPathFromVSCodeExecutablePath,
} from "@vscode/test-electron";

async function main(): Promise<void> {
  const extensionDevelopmentPath = path.resolve(__dirname, "../..");
  const extensionTestsPath = path.resolve(__dirname, "./suite/index");
  const cacheDir = path.resolve(__dirname, "../../.vscode-test");
  const sandboxExtensionsDir = path.join(cacheDir, "extensions");

  const vscodeExecutablePath = await downloadAndUnzipVSCode({ cachePath: cacheDir });

  if (process.env.DOCASSEMBLE_LSP_ENABLE_REAL_TEST === "1") {
    const cliPath = resolveCliPathFromVSCodeExecutablePath(vscodeExecutablePath);
    const hasPythonExt =
      existsSync(sandboxExtensionsDir) &&
      readdirSync(sandboxExtensionsDir).some((entry) => entry.startsWith("ms-python.python"));

    if (!hasPythonExt) {
      console.log("Installing ms-python.python into test sandbox...");
      const result = spawnSync(
        cliPath,
        [
          "--install-extension",
          "ms-python.python",
          "--extensions-dir",
          sandboxExtensionsDir,
          "--force",
        ],
        { encoding: "utf8", timeout: 60000 },
      );

      if (result.status !== 0) {
        console.error(
          `Warning: Failed to install ms-python.python: ${(result.stderr || result.stdout || "").trim()}`,
        );
      } else {
        console.log("Installed ms-python.python");
      }
    } else {
      console.log("ms-python.python already present in test sandbox");
    }
  }

  await runTests({
    extensionDevelopmentPath,
    extensionTestsPath,
    vscodeExecutablePath,
  });
}

void main();
