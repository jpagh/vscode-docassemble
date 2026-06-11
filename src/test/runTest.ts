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
  const cliPath = resolveCliPathFromVSCodeExecutablePath(vscodeExecutablePath);

  if (process.env.DOCASSEMBLE_LSP_ENABLE_REAL_TEST === "1") {
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

  // Pass the local LSP project path so tests can start the server via
  // `uv run --project <path> docassemble-lsp lsp` without needing it on PATH.
  const lspProject = path.resolve(__dirname, "../../../lsp");
  const testEnv: Record<string, string> = {
    DOCASSEMBLE_LSP_PROJECT: lspProject,
  };

  // ELECTRON_RUN_AS_NODE forces the Electron binary into Node.js mode, which
  // rejects unknown flags like --no-sandbox and --extensionTestsPath. Wrap
  // the binary to unset it and ensure VS Code / Electron app mode.
  const isMacArm = process.platform === "darwin" && process.arch === "arm64";
  if (isMacArm && process.env.ELECTRON_RUN_AS_NODE) {
    const wrapper = path.resolve(__dirname, "../../scripts/vscode-test-wrapper.mjs");
    await runTests({
      extensionDevelopmentPath,
      extensionTestsPath,
      vscodeExecutablePath: wrapper,
      extensionTestsEnv: { ...testEnv, VSCODE_ELECTRON_BIN: vscodeExecutablePath },
    });
  } else {
    await runTests({
      extensionDevelopmentPath,
      extensionTestsPath,
      vscodeExecutablePath,
      extensionTestsEnv: testEnv,
    });
  }
}

void main();
