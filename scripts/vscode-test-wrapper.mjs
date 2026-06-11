#!/usr/bin/env node
// Wrapper for the VS Code macOS ARM64 test runner.
// The Electron binary on macOS ARM64 switches to Node.js mode when
// ELECTRON_RUN_AS_NODE=1 is set, rejecting Electron/VS Code CLI flags.
// This wrapper spawns the binary with that variable removed.

import { execFileSync } from "node:child_process";

const bin = process.env.VSCODE_ELECTRON_BIN;
if (!bin) {
  console.error("VSCODE_ELECTRON_BIN is not set");
  process.exit(1);
}

// Copy the environment but omit ELECTRON_RUN_AS_NODE so the binary starts in
// VS Code / Electron app mode rather than Node.js mode.
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;

try {
  execFileSync(bin, process.argv.slice(2), { stdio: "inherit", env });
} catch (e) {
  process.exit(e.status ?? 1);
}
