#!/usr/bin/env bash
# Wrapper for VS Code macOS ARM64 test runner.
# The Electron binary on macOS ARM64 switches to Node.js mode when
# ELECTRON_RUN_AS_NODE=1 is set, rejecting Electron/VS Code CLI flags.
# This wrapper unsets that variable and calls the real binary.

ELECTRON_BIN="${VSCODE_ELECTRON_BIN:?VSCODE_ELECTRON_BIN not set}"

unset ELECTRON_RUN_AS_NODE

exec "$ELECTRON_BIN" "$@"
