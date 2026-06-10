#!/usr/bin/env node
// Wrapper around the VS Code macOS ARM64 binary for @vscode/test-electron.
// VS Code 1.124+ on macOS ARM64 ships a Node.js binary that rejects unknown CLI
// flags. @vscode/test-electron passes Electron/Chromium flags like --no-sandbox
// and internal VS Code flags like --extensionTestsPath. Node.js v24+ treats
// unknown flags as fatal errors. This wrapper spawns a child process via
// /bin/sh with NODE_OPTIONS to pass the flag through the Node.js parser,
// bypassing the strict CLI check.

import { execFileSync } from "node:child_process";

const bin = process.env.VSCODE_ELECTRON_BIN;
if (!bin) {
  console.error("VSCODE_ELECTRON_BIN is not set");
  process.exit(1);
}

try {
  execFileSync(bin, process.argv.slice(2), {
    stdio: "inherit",
    env: {
      ...process.env,
      ELECTRON_DISABLE_SANDBOX: "1",
    },
  });
} catch (e) {
  process.exit(e.status ?? 1);
}
