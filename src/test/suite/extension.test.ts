import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import * as vscode from "vscode";

type ServerState = "idle" | "disabled" | "missing" | "running" | "error" | "stopped";

type ServerStateSnapshot = {
  state: ServerState;
  resolvedCommand?: string;
  lastError?: string;
};

type DocassembleExtensionApi = {
  restart(): Promise<void>;
  showOutput(): void;
  showSetupHelp(): Promise<void>;
  getServerState(): ServerStateSnapshot;
};

type TestCase = {
  name: string;
  run: () => Promise<void>;
};

const EXTENSION_ID = "jackadamson.vscode-docassemble";

export async function runTests(): Promise<void> {
  const tests: TestCase[] = [
    {
      name: "defaults docassemble indentation to 2 spaces",
      run: async () => {
        await updateConfiguration("docassemble-lsp.enabled", false);

        const document = await vscode.workspace.openTextDocument({
          language: "docassemble",
          content: "---\n",
        });
        const editor = await vscode.window.showTextDocument(document);

        assert.equal(editor.options.tabSize, 2);
        assert.equal(editor.options.insertSpaces, true);
      },
    },
    {
      name: "stays healthy when the language server is disabled",
      run: async () => {
        await updateConfiguration("docassemble-lsp.enabled", false);

        const api = await getApi();

        const state = await waitForState(api, "disabled");
        assert.equal(state.state, "disabled");
      },
    },
    {
      name: "handles empty fromEnvironment command gracefully",
      run: async () => {
        await updateConfiguration("docassemble-lsp.enabled", true);
        await updateConfiguration("docassemble-lsp.importStrategy", "fromEnvironment");
        await updateConfiguration("docassemble-lsp.command", "");

        const api = await getApi();
        await api.restart();

        // The server may land in "running" (if docassemble-lsp is installed),
        // "missing" (if no python3), or "error" (if process failed).
        // The important thing is activation doesn't crash.
        await waitFor(() => {
          const s = api.getServerState();
          return s.state === "running" || s.state === "missing" || s.state === "error";
        });
      },
    },
    {
      name: "starts with a configured command",
      run: async () => {
        await updateConfiguration("docassemble-lsp.enabled", true);
        await updateConfiguration("docassemble-lsp.importStrategy", "fromEnvironment");
        await updateConfiguration(
          "docassemble-lsp.command",
          `${quoteForShell(process.execPath)} ${quoteForShell(mockServerPath())}`,
        );

        const api = await getApi();
        await api.restart();

        const state = await waitForState(api, "running");
        assert.match(state.resolvedCommand ?? "", /mock-lsp-server\.js/);
      },
    },
    {
      name: "formats on type through the language server",
      run: async () => {
        const logPath = path.join(os.tmpdir(), `docassemble-mock-lsp-${Date.now()}.log`);

        await updateConfiguration("docassemble-lsp.enabled", true);
        await updateConfiguration("docassemble-lsp.importStrategy", "fromEnvironment");
        await updateConfiguration(
          "docassemble-lsp.command",
          `${quoteForShell(process.execPath)} ${quoteForShell(mockServerPath())}`,
        );
        await updateConfiguration("docassemble-lsp.env", { DOCASSEMBLE_MOCK_LOG: logPath });
        await updateConfiguration("editor.formatOnType", true);
        await updateLanguageConfiguration("docassemble", {
          "editor.defaultFormatter": EXTENSION_ID,
          "editor.formatOnType": true,
        });

        const api = await getApi();
        await api.restart();
        await waitForState(api, "running");

        const document = await vscode.workspace.openTextDocument({
          language: "docassemble",
          content: "fields:\n  - label: First",
        });
        const editor = await vscode.window.showTextDocument(document);
        const end = document.positionAt(document.getText().length);
        editor.selection = new vscode.Selection(end, end);

        await vscode.commands.executeCommand("type", { text: "\n" });

        await waitFor(() => document.getText() === "fields:\n  - label: First\n    ");
        await waitFor(() => readLog(logPath).includes("textDocument/onTypeFormatting"));
      },
    },
    {
      name: "clears docassemble diagnostics after switching language mode to yaml",
      run: async () => {
        await updateConfiguration("docassemble-lsp.enabled", true);
        await updateConfiguration("docassemble-lsp.importStrategy", "fromEnvironment");
        await updateConfiguration(
          "docassemble-lsp.command",
          `${quoteForShell(process.execPath)} ${quoteForShell(mockServerPath())}`,
        );

        const api = await getApi();
        await api.restart();
        await waitForState(api, "running");

        const document = await vscode.workspace.openTextDocument({
          language: "docassemble",
          content: "mock diagnostic\n",
        });

        await vscode.window.showTextDocument(document);
        await waitFor(() => vscode.languages.getDiagnostics(document.uri).length === 1);

        const yamlDocument = await vscode.languages.setTextDocumentLanguage(document, "yaml");

        assert.equal(yamlDocument.languageId, "yaml");
        await waitFor(() => vscode.languages.getDiagnostics(yamlDocument.uri).length === 0);
      },
    },
    {
      name: "starts with system docassemble-lsp when available",
      run: async () => {
        if (
          process.env.DOCASSEMBLE_LSP_ENABLE_REAL_TEST !== "1" ||
          !commandExists("docassemble-lsp")
        ) {
          throw new SkipTest();
        }

        await resetConfiguration();
        await updateConfiguration("docassemble-lsp.importStrategy", "fromEnvironment");
        await updateConfiguration("docassemble-lsp.command", "docassemble-lsp lsp");

        const api = await getApi();
        await api.restart();

        const state = await waitForState(api, "running");
        assert.match(state.resolvedCommand ?? "", /docassemble-lsp lsp$/);
      },
    },
    {
      name: "starts bundled server via interpreter",
      run: async () => {
        if (process.env.DOCASSEMBLE_LSP_ENABLE_REAL_TEST !== "1" || !python3Available()) {
          throw new SkipTest();
        }

        await resetConfiguration();
        await updateConfiguration("docassemble-lsp.importStrategy", "useBundled");
        await updateConfiguration("docassemble-lsp.interpreter", []);

        const api = await getApi();
        await api.restart();

        const state = await waitForState(api, "running");
        assert.match(state.resolvedCommand ?? "", /python.*run_server\.py$/);
      },
    },
    {
      name: "publishes diagnostics for invalid YAML key via bundled server",
      run: async () => {
        if (process.env.DOCASSEMBLE_LSP_ENABLE_REAL_TEST !== "1" || !python3Available()) {
          throw new SkipTest();
        }

        await resetConfiguration();
        await updateConfiguration("docassemble-lsp.importStrategy", "useBundled");
        await updateConfiguration("docassemble-lsp.interpreter", []);

        const api = await getApi();
        await api.restart();
        await waitForState(api, "running");

        const document = await vscode.workspace.openTextDocument({
          language: "docassemble",
          content: "question: |\n  test\nfoobar: bad\n",
        });
        await vscode.window.showTextDocument(document);

        await waitFor(() => {
          const diags = vscode.languages.getDiagnostics(document.uri);
          return diags.some((d) => String(d.code) === "E301");
        });
      },
    },
    {
      name: "provides completions via bundled server",
      run: async () => {
        if (process.env.DOCASSEMBLE_LSP_ENABLE_REAL_TEST !== "1" || !python3Available()) {
          throw new SkipTest();
        }

        await resetConfiguration();
        await updateConfiguration("docassemble-lsp.importStrategy", "useBundled");
        await updateConfiguration("docassemble-lsp.interpreter", []);

        const api = await getApi();
        await api.restart();
        await waitForState(api, "running");

        const document = await vscode.workspace.openTextDocument({
          language: "docassemble",
          content: "question:\n  ",
        });
        const editor = await vscode.window.showTextDocument(document);
        const pos = new vscode.Position(1, 2);

        const items = await vscode.commands.executeCommand<vscode.CompletionList>(
          "vscode.executeCompletionItemProvider",
          document.uri,
          pos,
        );

        assert.ok(items, "Expected a completion list");
        assert.ok(items.items.length > 0, "Expected at least one completion item");
      },
    },
    {
      name: "provides hover info via bundled server",
      run: async () => {
        if (process.env.DOCASSEMBLE_LSP_ENABLE_REAL_TEST !== "1" || !python3Available()) {
          throw new SkipTest();
        }

        await resetConfiguration();
        await updateConfiguration("docassemble-lsp.importStrategy", "useBundled");
        await updateConfiguration("docassemble-lsp.interpreter", []);

        const api = await getApi();
        await api.restart();
        await waitForState(api, "running");

        const document = await vscode.workspace.openTextDocument({
          language: "docassemble",
          content: "question: |\n  test\n",
        });
        await vscode.window.showTextDocument(document);

        const hovers = await vscode.commands.executeCommand<vscode.Hover[]>(
          "vscode.executeHoverProvider",
          document.uri,
          new vscode.Position(0, 1),
        );

        assert.ok(hovers && hovers.length > 0, "Expected at least one hover result");
        assert.ok(hovers[0].contents.length > 0, "Expected hover content");
      },
    },
    {
      name: "provides document symbols via bundled server",
      run: async () => {
        if (process.env.DOCASSEMBLE_LSP_ENABLE_REAL_TEST !== "1" || !python3Available()) {
          throw new SkipTest();
        }

        await resetConfiguration();
        await updateConfiguration("docassemble-lsp.importStrategy", "useBundled");
        await updateConfiguration("docassemble-lsp.interpreter", []);

        const api = await getApi();
        await api.restart();
        await waitForState(api, "running");

        const document = await vscode.workspace.openTextDocument({
          language: "docassemble",
          content: "question: |\n  test\ncode: |\n  x = 1\n",
        });
        await vscode.window.showTextDocument(document);

        const symbols = await vscode.commands.executeCommand<vscode.DocumentSymbol[]>(
          "vscode.executeDocumentSymbolProvider",
          document.uri,
        );

        assert.ok(symbols && symbols.length > 0, "Expected document symbols");
      },
    },
    {
      name: "provides code actions for invalid key via bundled server",
      run: async () => {
        if (process.env.DOCASSEMBLE_LSP_ENABLE_REAL_TEST !== "1" || !python3Available()) {
          throw new SkipTest();
        }

        await resetConfiguration();
        await updateConfiguration("docassemble-lsp.importStrategy", "useBundled");
        await updateConfiguration("docassemble-lsp.interpreter", []);

        const api = await getApi();
        await api.restart();
        await waitForState(api, "running");

        const document = await vscode.workspace.openTextDocument({
          language: "docassemble",
          content: "question: |\n  test\nfoobar: bad\n",
        });
        await vscode.window.showTextDocument(document);

        await waitFor(() =>
          vscode.languages.getDiagnostics(document.uri).some((d) => String(d.code) === "E301"),
        );

        const codeActions = await vscode.commands.executeCommand<vscode.CodeAction[]>(
          "vscode.executeCodeActionProvider",
          document.uri,
          new vscode.Range(0, 0, 2, 0),
        );

        assert.ok(codeActions && codeActions.length > 0, "Expected code actions for diagnostic");
      },
    },
    {
      name: "starts with Python extension integration",
      run: async () => {
        if (!pythonExtensionAvailable()) {
          throw new SkipTest();
        }

        await resetConfiguration();
        await updateConfiguration("docassemble-lsp.importStrategy", "useBundled");
        await updateConfiguration("docassemble-lsp.interpreter", []);

        const api = await getApi();
        await api.restart();

        const state = await waitForState(api, "running");
        assert.ok(state.resolvedCommand, "Expected a resolved interpreter command");
        assert.doesNotMatch(
          state.resolvedCommand ?? "",
          /python3$/,
          "Expected Python extension to resolve a real interpreter, not fallback",
        );
      },
    },
  ];

  console.log("\n  Docassemble extension");

  let passed = 0;
  let skipped = 0;
  const failures: Array<{ name: string; error: unknown }> = [];

  for (const test of tests) {
    try {
      await test.run();
      passed += 1;
      console.log(`    ok ${test.name}`);
    } catch (error) {
      if (error instanceof SkipTest) {
        skipped += 1;
        console.log(`    - ${test.name}`);
      } else {
        failures.push({ name: test.name, error });
        console.log(`    ${failures.length}) ${test.name}`);
      }
    } finally {
      await resetConfiguration();
    }
  }

  console.log(`  ${passed} passing`);
  if (skipped > 0) {
    console.log(`  ${skipped} pending`);
  }

  if (failures.length > 0) {
    for (const [index, failure] of failures.entries()) {
      console.error(`  ${index + 1}) Docassemble extension`);
      console.error(`       ${failure.name}:`);
      console.error(formatError(failure.error));
    }

    throw new Error(`${failures.length} test(s) failed.`);
  }
}

class SkipTest extends Error {}

async function getApi(): Promise<DocassembleExtensionApi> {
  const extension = vscode.extensions.getExtension<DocassembleExtensionApi>(EXTENSION_ID);
  assert.ok(extension, `Expected extension ${EXTENSION_ID} to be available.`);
  const api = await extension.activate();
  assert.ok(api, `${EXTENSION_ID}.activate() returned undefined`);
  return api;
}

async function updateConfiguration<T>(section: string, value: T): Promise<void> {
  await vscode.workspace
    .getConfiguration()
    .update(section, value, vscode.ConfigurationTarget.Global);
}

async function resetConfiguration(): Promise<void> {
  // Disable the server first so it stops cleanly, preventing noisy
  // unhandled-rejection warnings from the language-client when pending
  // responses are dropped during a config-triggered restart.
  await updateConfiguration("docassemble-lsp.enabled", false);
  try {
    const api = vscode.extensions.getExtension<DocassembleExtensionApi>(EXTENSION_ID)?.exports;
    if (api) {
      await waitForState(api, "disabled");
    }
  } catch {
    // If the extension API is unavailable, fall back to a timed wait
    await sleep(500);
  }
  // Clear remaining settings while the server is disabled, then re-enable
  await updateConfiguration("docassemble-lsp.importStrategy", undefined);
  await updateConfiguration("docassemble-lsp.command", undefined);
  await updateConfiguration("docassemble-lsp.interpreter", undefined);
  await updateConfiguration("docassemble-lsp.env", undefined);
  await updateConfiguration("docassemble-lsp.trace.server", undefined);
  await updateConfiguration("docassemble-lsp.showNotifications", undefined);
  await updateConfiguration("editor.formatOnType", undefined);
  await updateConfiguration("editor.insertSpaces", undefined);
  await updateConfiguration("editor.tabSize", undefined);
  await updateLanguageConfiguration("docassemble", undefined);
  await updateConfiguration("docassemble-lsp.enabled", undefined);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function mockServerPath(): string {
  const extension = vscode.extensions.getExtension(EXTENSION_ID);
  assert.ok(extension, `Expected extension ${EXTENSION_ID} to be available.`);
  return path.join(extension.extensionPath, "dist", "test", "fixtures", "mock-lsp-server.js");
}

function bundledServerPath(): string {
  const extension = vscode.extensions.getExtension(EXTENSION_ID);
  assert.ok(extension, `Expected extension ${EXTENSION_ID} to be available.`);
  return path.join(extension.extensionPath, "bundled", "run_server.py");
}

function python3Available(): boolean {
  return commandExists("python3");
}

function pythonExtensionAvailable(): boolean {
  return (
    process.env.DOCASSEMBLE_LSP_ENABLE_REAL_TEST === "1" &&
    !!vscode.extensions.getExtension("ms-python.python")
  );
}

function commandExists(command: string): boolean {
  if (path.isAbsolute(command) || command.includes(path.sep)) {
    return isExecutable(command);
  }

  const pathValue = process.env.PATH;
  if (!pathValue) {
    return false;
  }

  for (const directory of pathValue.split(path.delimiter).filter(Boolean)) {
    const candidate = path.join(directory, command);
    if (isExecutable(candidate)) {
      return true;
    }
  }

  return false;
}

function isExecutable(candidatePath: string): boolean {
  try {
    fs.accessSync(candidatePath, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function formatError(error: unknown): string {
  if (error instanceof Error) {
    return error.stack ?? error.message;
  }

  return String(error);
}

function quoteForShell(value: string): string {
  if (process.platform === "win32") {
    return `"${value.replaceAll('"', '\\"')}"`;
  }

  return `'${value.replaceAll("'", "'\\''")}'`;
}

function readLog(logPath: string): string {
  try {
    return fs.readFileSync(logPath, "utf8");
  } catch {
    return "";
  }
}

async function updateLanguageConfiguration(
  languageId: string,
  value: Record<string, unknown> | undefined,
): Promise<void> {
  await vscode.workspace
    .getConfiguration()
    .update(`[${languageId}]`, value, vscode.ConfigurationTarget.Global);
}

async function waitFor(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
  for (let attempt = 0; attempt < timeoutMs / 50; attempt += 1) {
    if (predicate()) {
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  throw new Error("Timed out waiting for condition.");
}

async function waitForState(
  api: DocassembleExtensionApi,
  expectedState: ServerState,
): Promise<ServerStateSnapshot> {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const snapshot = api.getServerState();
    if (snapshot.state === expectedState) {
      return snapshot;
    }

    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  throw new Error(
    `Timed out waiting for state ${expectedState}; last state was ${api.getServerState().state}.`,
  );
}
