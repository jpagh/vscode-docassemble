import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import * as path from "path";
import * as vscode from "vscode";
import {
  CloseAction,
  ErrorAction,
  FileChangeType,
  LanguageClient,
  RevealOutputChannelOn,
  ServerOptions,
  State as ClientState,
  Trace,
} from "vscode-languageclient/node";
import { PythonExtension } from "@vscode/python-extension";

const CONFIG_SECTION = "docassemble-lsp";
const DIAGNOSTIC_LANGUAGE_IDS = new Set(["docassemble", "yaml"]);

export type ServerState = "idle" | "disabled" | "missing" | "running" | "error" | "stopped";

export type ServerStateSnapshot = {
  state: ServerState;
  resolvedCommand?: string;
  lastError?: string;
};

export type DocassembleExtensionApi = {
  restart(): Promise<void>;
  showOutput(): void;
  showSetupHelp(): Promise<void>;
  getServerState(): ServerStateSnapshot;
};

type ResolvedCommand = {
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  display: string;
  shell?: boolean;
};

class DocassembleLspController {
  private client: LanguageClient | undefined;
  private serverState: ServerState = "idle";
  private lastResolvedCommand: string | undefined;
  private lastError: string | undefined;
  private lifecycle: Promise<void> = Promise.resolve();
  private restartTimer: NodeJS.Timeout | undefined;
  private fileWatchers: vscode.Disposable[] = [];
  private linkRegistration: vscode.Disposable | undefined;
  private readonly bundledLspVersion: string | undefined;

  public constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly output: vscode.OutputChannel,
    private readonly statusBar: vscode.StatusBarItem,
  ) {
    this.bundledLspVersion = this.readBundledLspVersion();
    this.updateStatusBar();
  }

  public async start(): Promise<void> {
    this.cancelScheduledRestart();
    await this.enqueue(async () => {
      await this.startInternal();
    });
  }

  public async restart(): Promise<void> {
    this.cancelScheduledRestart();
    await this.enqueue(async () => {
      try {
        await this.stopInternal();
      } catch {
        this.log("Failed to stop language server; forcing restart.");
      }
      await this.startInternal();
    });
  }

  public async stop(): Promise<void> {
    this.cancelScheduledRestart();
    await this.enqueue(async () => {
      try {
        await this.stopInternal();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.log(`Server stop failed: ${message}`);
      }
    });
  }

  private async startInternal(): Promise<void> {
    if (this.client) {
      return;
    }

    this.setServerState("idle");

    const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
    if (!config.get<boolean>("enabled", true)) {
      this.setServerState("disabled");
      this.lastResolvedCommand = undefined;
      this.lastError = undefined;
      this.log("Language server startup skipped because docassemble-lsp.enabled is false.");
      return;
    }

    this.log(`Extension version: ${this.context.extension.packageJSON.version}`);
    if (this.bundledLspVersion) {
      this.log(`Bundled docassemble-lsp version: ${this.bundledLspVersion}`);
    }

    let resolvedCommand: ResolvedCommand | undefined;
    try {
      resolvedCommand = await this.resolveCommand(config);
    } catch (error) {
      this.setServerState("error");
      const message = error instanceof Error ? error.message : String(error);
      this.lastError = message;
      this.log(`Language server command resolution failed: ${message}`);
      return;
    }
    if (!resolvedCommand) {
      this.setServerState("missing");
      this.log(
        "Language server startup skipped because the configured command could not be resolved.",
      );
      return;
    }

    this.lastResolvedCommand = resolvedCommand.display;
    this.lastError = undefined;

    const importStrategy = config.get<string>("importStrategy", "useBundled");
    this.log(
      `Starting server (${resolvedCommand.shell ? "command" : importStrategy}): ${resolvedCommand.display}`,
    );

    const serverOptions: ServerOptions = {
      command: resolvedCommand.command,
      args: resolvedCommand.args,
      options: {
        env: resolvedCommand.env,
        shell: resolvedCommand.shell,
      },
    };

    const client = new LanguageClient(
      "docassemble-lsp",
      "Docassemble Language Server",
      serverOptions,
      {
        errorHandler: {
          error: () => ({ action: ErrorAction.Shutdown }),
          closed: () => ({ action: CloseAction.DoNotRestart }),
        },
        documentSelector: [
          { language: "docassemble", scheme: "file" },
          { language: "docassemble", scheme: "untitled" },
        ],
        middleware: {
          provideDocumentLinks: async () => {
            return [];
          },
          provideOnTypeFormattingEdits: async (document, position, ch, options, token, next) => {
            this.logOnTypeFormattingRequest(document, position, ch);
            const edits = await next(document, position, ch, options, token);
            this.logOnTypeFormattingResponse(document, position, edits ?? []);
            return edits;
          },
        },
        outputChannel: this.output,
        revealOutputChannelOn: RevealOutputChannelOn.Never,
      },
    );

    this.client = client;

    const traceSetting = config.get<string>("trace.server", "off");
    client.setTrace(this.toTrace(traceSetting));

    try {
      await client.start();
      this.setServerState("running");
      this.log(`Language server started with command: ${resolvedCommand.command}`);

      // Register a local DocumentLinkProvider so VS Code draws persistent
      // underlines for module/include/static/template references. The LSP client
      // auto-registers a provider too, but VS Code only renders underlines from
      // local providers — not from LSP-delegated ones.
      this.linkRegistration = vscode.languages.registerDocumentLinkProvider(
        { language: "docassemble", scheme: "file" },
        {
          provideDocumentLinks: async (document) => {
            if (!this.client || this.client.state !== ClientState.Running) {
              return [];
            }
            const params = {
              textDocument: { uri: document.uri.toString() },
            };
            type LinkItem = {
              range: {
                start: { line: number; character: number };
                end: { line: number; character: number };
              };
              target?: string;
            };

            try {
              const links = await this.client.sendRequest<LinkItem[] | null>(
                "textDocument/documentLink",
                params,
              );
              if (!links) {
                return [];
              }
              return links
                .filter((l) => {
                  const sameLine = l.range.start.line === l.range.end.line;
                  const sameChar = l.range.start.character === l.range.end.character;
                  return !(sameLine && sameChar);
                })
                .map(
                  (l) =>
                    new vscode.DocumentLink(
                      new vscode.Range(
                        l.range.start.line,
                        l.range.start.character,
                        l.range.end.line,
                        l.range.end.character,
                      ),
                      l.target ? vscode.Uri.parse(l.target) : undefined,
                    ),
                );
            } catch (error) {
              const message = error instanceof Error ? error.message : String(error);
              this.log(`Document link provider failed: ${message}`);
              return [];
            }
          },
        },
      );

      // Set up VS Code file watchers that send workspace/didChangeWatchedFiles to the server
      this.registerFileWatchers(client);
    } catch (error) {
      this.client = undefined;
      const message = error instanceof Error ? error.message : String(error);
      this.lastError = message;
      this.setServerState("error");
      this.log(`Language server failed to start: ${message}`);
      void vscode.window.showWarningMessage(
        "Docassemble language server could not be started. See the Docassemble Language Server output for details.",
      );
    }
  }

  private async stopInternal(): Promise<void> {
    if (!this.client) {
      return;
    }

    this.disposeFileWatchers();

    if (this.linkRegistration) {
      this.linkRegistration.dispose();
      this.linkRegistration = undefined;
    }

    const client = this.client;
    this.client = undefined;

    try {
      await client.stop(2000);
    } catch (error) {
      // Client may be in Starting/StartFailed state where stop() rejects.
      // Clean up with dispose() instead — it may also throw but we can ignore it.
      const message = error instanceof Error ? error.message : String(error);
      this.log(`Language server stop failed (${message}); disposing.`);
      try {
        client.dispose();
      } catch {
        // dispose also failed — client is already in a terminal state, nothing to do.
      }
    }

    this.setServerState("stopped");
    this.log("Language server stopped.");
  }

  public showOutput(): void {
    this.output.show(true);
  }

  public async showSetupHelp(): Promise<void> {
    this.output.appendLine("[docassemble-lsp] Setup help");
    this.output.appendLine(
      "[docassemble-lsp] Two server strategies, configured via docassemble-lsp.importStrategy:",
    );
    this.output.appendLine(
      '[docassemble-lsp]   "useBundled" (default) — runs the server shipped in the extension via the Python interpreter',
    );
    this.output.appendLine(
      '[docassemble-lsp]   "fromEnvironment" — runs "python -m docassemble_lsp lsp", or the docassemble-lsp.command string if set',
    );
    this.output.appendLine(
      "[docassemble-lsp] Set docassemble-lsp.interpreter to override the Python interpreter used for either strategy.",
    );

    const selection = await vscode.window.showInformationMessage(
      "Configure docassemble-lsp importStrategy, command, or interpreter.",
      "Open Settings",
      "Show Output",
    );

    if (selection === "Open Settings") {
      await vscode.commands.executeCommand("workbench.action.openSettings", "docassemble-lsp");
      return;
    }

    if (selection === "Show Output") {
      this.showOutput();
    }
  }

  public async handleConfigurationChange(event: vscode.ConfigurationChangeEvent): Promise<void> {
    if (!event.affectsConfiguration(CONFIG_SECTION)) {
      return;
    }

    this.cancelScheduledRestart();
    this.restartTimer = setTimeout(() => {
      this.restartTimer = undefined;
      this.restart().catch((error) => {
        this.log(
          `Configuration restart failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      });
    }, 150);
  }

  public getServerState(): ServerStateSnapshot {
    return {
      state: this.serverState,
      resolvedCommand: this.lastResolvedCommand,
      lastError: this.lastError,
    };
  }

  public handleActiveEditorChange(editor: vscode.TextEditor | undefined): void {
    if (!editor) {
      return;
    }

    this.logDocumentContext("Active editor", editor.document);
  }

  public handleDocumentOpen(document: vscode.TextDocument): void {
    this.clearDiagnosticsForInactiveDocument(document);
    this.logDocumentContext("Opened document", document);
  }

  public handleDocumentChange(event: vscode.TextDocumentChangeEvent): void {
    const document = event.document;
    if (!this.shouldLogDocument(document)) {
      return;
    }

    const newlineChanges = event.contentChanges.filter((change) => change.text.includes("\n"));
    if (newlineChanges.length === 0) {
      return;
    }

    const { defaultFormatter, formatOnType } = this.getEditorFormattingSettings(document);
    const positions = newlineChanges
      .map((change) => `${change.range.start.line + 1}:${change.range.start.character + 1}`)
      .join(", ");

    this.log(
      `Enter/newline detected: languageId=${document.languageId} scheme=${document.uri.scheme} selectorMatch=${this.matchesDocumentSelector(document)} formatOnType=${String(formatOnType)} defaultFormatter=${defaultFormatter ?? "<none>"} positions=${positions}`,
    );
  }

  private async resolveCommand(
    config: vscode.WorkspaceConfiguration,
  ): Promise<ResolvedCommand | undefined> {
    const resolvedEnv = {
      ...process.env,
      ...config.get<Record<string, string>>("env", {}),
    };

    const importStrategy = config.get<string>("importStrategy", "useBundled");
    const configuredCommand = config.get<string>("command", "").trim();

    if (importStrategy === "fromEnvironment" && configuredCommand) {
      return {
        command: configuredCommand,
        args: [],
        env: resolvedEnv,
        display: configuredCommand,
        shell: true,
      };
    }

    const configuredInterpreter = config.get<string[]>("interpreter", []);
    let interpreter: string;
    if (configuredInterpreter.length > 0) {
      interpreter = configuredInterpreter[0];
    } else {
      try {
        const pythonApi = await PythonExtension.api();
        const envPath = pythonApi.environments.getActiveEnvironmentPath();
        const environment = await pythonApi.environments.resolveEnvironment(envPath);
        interpreter = environment?.executable?.uri?.fsPath ?? "python3";
      } catch {
        interpreter = "python3";
      }
    }

    // Check that the interpreter actually exists before starting
    if (interpreter === "python3" || interpreter === "python" || interpreter === "py") {
      if (!this.commandExists(interpreter)) {
        this.setServerState("missing");
        this.log(
          `Python interpreter "${interpreter}" not found on PATH. ` +
            "Install Python or add it to your PATH, or install the ms-python.python extension.",
        );
        return undefined;
      }
    } else {
      // Full path — check file exists
      if (!(await this.fileExists(interpreter))) {
        this.setServerState("missing");
        this.log(`Python interpreter not found at "${interpreter}".`);
        return undefined;
      }
    }

    if (importStrategy === "useBundled") {
      const bundledEntry = path.join(this.context.extensionPath, "bundled", "run_server.py");
      if (!(await this.fileExists(bundledEntry))) {
        this.setServerState("missing");
        this.log(
          `Bundled server not found at ${bundledEntry}. ` +
            `Run "npm run bundle-server" or set docassemble-lsp.importStrategy to "fromEnvironment".`,
        );
        return undefined;
      }
      return {
        command: interpreter,
        args: [bundledEntry],
        env: resolvedEnv,
        display: `${interpreter} ${bundledEntry}`,
      };
    }

    return {
      command: interpreter,
      args: ["-m", "docassemble_lsp", "lsp"],
      env: resolvedEnv,
      display: `${interpreter} -m docassemble_lsp lsp`,
    };
  }

  private async fileExists(filePath: string): Promise<boolean> {
    try {
      await vscode.workspace.fs.stat(vscode.Uri.file(filePath));
      return true;
    } catch {
      return false;
    }
  }

  private commandExists(command: string): boolean {
    const checkCommand = process.platform === "win32" ? "where" : "which";
    try {
      execSync(`${checkCommand} "${command}"`, { stdio: "ignore" });
      return true;
    } catch {
      return false;
    }
  }

  private readBundledLspVersion(): string | undefined {
    const versionPath = path.join(this.context.extensionPath, "bundled", "bundled-lsp-version.txt");
    try {
      return readFileSync(versionPath, "utf-8").trim();
    } catch {
      return undefined;
    }
  }

  private toTrace(value: string): Trace {
    switch (value) {
      case "messages":
        return Trace.Messages;
      case "verbose":
        return Trace.Verbose;
      default:
        return Trace.Off;
    }
  }

  private log(message: string): void {
    this.output.appendLine(`[docassemble-lsp] ${message}`);
  }

  private logDocumentContext(prefix: string, document: vscode.TextDocument): void {
    if (!this.shouldLogDocument(document)) {
      return;
    }

    const { defaultFormatter, formatOnType } = this.getEditorFormattingSettings(document);
    this.log(
      `${prefix}: languageId=${document.languageId} scheme=${document.uri.scheme} selectorMatch=${this.matchesDocumentSelector(document)} formatOnType=${String(formatOnType)} defaultFormatter=${defaultFormatter ?? "<none>"} uri=${document.uri.toString()}`,
    );
  }

  private logOnTypeFormattingRequest(
    document: vscode.TextDocument,
    position: vscode.Position,
    ch: string,
  ): void {
    if (!this.shouldLogDocument(document)) {
      return;
    }

    const { defaultFormatter, formatOnType } = this.getEditorFormattingSettings(document);
    this.log(
      `onTypeFormatting request: languageId=${document.languageId} scheme=${document.uri.scheme} selectorMatch=${this.matchesDocumentSelector(document)} trigger=${JSON.stringify(ch)} position=${position.line + 1}:${position.character + 1} formatOnType=${String(formatOnType)} defaultFormatter=${defaultFormatter ?? "<none>"}`,
    );
  }

  private logOnTypeFormattingResponse(
    document: vscode.TextDocument,
    position: vscode.Position,
    edits: readonly vscode.TextEdit[],
  ): void {
    if (!this.shouldLogDocument(document)) {
      return;
    }

    const verboseDetails =
      this.getTraceSetting() === "verbose" ? ` edits=${JSON.stringify(edits)}` : "";
    this.log(
      `onTypeFormatting response: languageId=${document.languageId} edits=${edits.length}${verboseDetails}`,
    );

    if (edits.length > 0) {
      this.schedulePostFormattingProbe(document.uri, position.line);
    }
  }

  private schedulePostFormattingProbe(uri: vscode.Uri, line: number): void {
    if (this.getTraceSetting() === "off") {
      return;
    }

    setTimeout(() => {
      const document = vscode.workspace.textDocuments.find(
        (candidate) => candidate.uri.toString() === uri.toString(),
      );
      if (!document || !this.shouldLogDocument(document) || line >= document.lineCount) {
        return;
      }

      this.log(
        `onTypeFormatting applied check: languageId=${document.languageId} line=${line + 1} text=${JSON.stringify(document.lineAt(line).text)}`,
      );
    }, 50);
  }

  private shouldLogDocument(document: vscode.TextDocument): boolean {
    return this.getTraceSetting() !== "off" && DIAGNOSTIC_LANGUAGE_IDS.has(document.languageId);
  }

  private clearDiagnosticsForInactiveDocument(document: vscode.TextDocument): void {
    if (document.languageId === "docassemble") {
      return;
    }

    this.client?.diagnostics?.delete(document.uri);
  }

  private matchesDocumentSelector(document: vscode.TextDocument): boolean {
    return (
      document.languageId === "docassemble" &&
      (document.uri.scheme === "file" || document.uri.scheme === "untitled")
    );
  }

  private getEditorFormattingSettings(document: vscode.TextDocument): {
    defaultFormatter?: string;
    formatOnType?: boolean;
  } {
    const editorConfig = vscode.workspace.getConfiguration("editor", document.uri);
    return {
      defaultFormatter: editorConfig.get<string>("defaultFormatter"),
      formatOnType: editorConfig.get<boolean>("formatOnType"),
    };
  }

  private getTraceSetting(): string {
    return vscode.workspace.getConfiguration(CONFIG_SECTION).get<string>("trace.server", "off");
  }

  private async enqueue(operation: () => Promise<void>): Promise<void> {
    const next = this.lifecycle.then(operation, operation);
    this.lifecycle = next.catch(() => undefined);
    await next;
  }

  private cancelScheduledRestart(): void {
    if (!this.restartTimer) {
      return;
    }

    clearTimeout(this.restartTimer);
    this.restartTimer = undefined;
  }

  private registerFileWatchers(client: LanguageClient): void {
    const yamlWatcher = vscode.workspace.createFileSystemWatcher("**/*.{yml,yaml}");
    const pyWatcher = vscode.workspace.createFileSystemWatcher("**/*.py");

    const sendChange = (uri: vscode.Uri, type: FileChangeType): void => {
      client.sendNotification("workspace/didChangeWatchedFiles", {
        changes: [{ uri: uri.toString(), type }],
      });
    };

    this.fileWatchers.push(
      yamlWatcher,
      pyWatcher,
      yamlWatcher.onDidChange((uri) => sendChange(uri, FileChangeType.Changed)),
      yamlWatcher.onDidCreate((uri) => sendChange(uri, FileChangeType.Created)),
      yamlWatcher.onDidDelete((uri) => sendChange(uri, FileChangeType.Deleted)),
      pyWatcher.onDidChange((uri) => sendChange(uri, FileChangeType.Changed)),
      pyWatcher.onDidCreate((uri) => sendChange(uri, FileChangeType.Created)),
      pyWatcher.onDidDelete((uri) => sendChange(uri, FileChangeType.Deleted)),
    );

    this.log("File watchers registered for **/*.{yml,yaml} and **/*.py");
  }

  private disposeFileWatchers(): void {
    for (const disposable of this.fileWatchers) {
      disposable.dispose();
    }
    this.fileWatchers = [];
  }

  private setServerState(state: ServerState): void {
    this.serverState = state;
    this.updateStatusBar();
  }

  private updateStatusBar(): void {
    switch (this.serverState) {
      case "running":
        this.statusBar.text = "$(check) Docassemble LSP";
        this.statusBar.tooltip = this.lastResolvedCommand
          ? `${this.lastResolvedCommand}${this.bundledLspVersion ? ` (LSP v${this.bundledLspVersion})` : ""} — click to restart`
          : "Docassemble LSP: click to restart";
        this.statusBar.command = "docassemble-lsp.restart";
        break;
      case "missing":
        this.statusBar.text = "$(warning) Docassemble LSP";
        this.statusBar.tooltip = "No Docassemble LSP command is configured. Click for setup help.";
        this.statusBar.command = "docassemble-lsp.showSetupHelp";
        break;
      case "disabled":
        this.statusBar.text = "$(circle-slash) Docassemble LSP";
        this.statusBar.tooltip = "Docassemble language server is disabled in settings.";
        this.statusBar.command = "docassemble-lsp.showSetupHelp";
        break;
      case "error":
        this.statusBar.text = "$(error) Docassemble LSP";
        this.statusBar.tooltip = this.lastError
          ? `Docassemble language server failed to start: ${this.lastError}`
          : "Docassemble language server failed to start.";
        this.statusBar.command = "docassemble-lsp.showOutput";
        break;
      case "stopped":
        this.statusBar.text = "$(debug-stop) Docassemble LSP";
        this.statusBar.tooltip = "Docassemble language server is stopped.";
        this.statusBar.command = "docassemble-lsp.restart";
        break;
      default:
        this.statusBar.text = "$(sync~spin) Docassemble LSP";
        this.statusBar.tooltip = "Docassemble language server is starting.";
        this.statusBar.command = "docassemble-lsp.showOutput";
        break;
    }

    this.statusBar.show();
  }
}

let activeController: DocassembleLspController | undefined;

function isKnownClientError(reason: unknown): boolean {
  const message = reason instanceof Error ? reason.message : String(reason);
  return message.includes("Client is not running") || message.includes("Pending response rejected");
}

export async function activate(context: vscode.ExtensionContext): Promise<DocassembleExtensionApi> {
  const output = vscode.window.createOutputChannel("Docassemble Language Server");
  const statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 10);
  statusBar.name = "Docassemble Language Server";

  const unhandledHandler = (reason: unknown): void => {
    if (!isKnownClientError(reason)) {
      console.error("[docassemble-lsp] Unhandled rejection:", reason);
    }
  };
  process.on("unhandledRejection", unhandledHandler);
  context.subscriptions.push({
    dispose: () => process.off("unhandledRejection", unhandledHandler),
  });
  const controller = new DocassembleLspController(context, output, statusBar);
  activeController = controller;

  context.subscriptions.push(
    output,
    statusBar,
    vscode.commands.registerCommand("docassemble-lsp.restart", () => {
      controller.restart();
    }),
    vscode.commands.registerCommand("docassemble-lsp.showOutput", () => {
      controller.showOutput();
    }),
    vscode.commands.registerCommand("docassemble-lsp.showSetupHelp", () => {
      controller.showSetupHelp();
    }),
    vscode.workspace.onDidChangeConfiguration((event) => {
      controller.handleConfigurationChange(event);
    }),
    vscode.window.onDidChangeActiveTextEditor((editor) => {
      controller.handleActiveEditorChange(editor);
    }),
    vscode.workspace.onDidOpenTextDocument((document) => {
      controller.handleDocumentOpen(document);
    }),
    vscode.workspace.onDidChangeTextDocument((event) => {
      controller.handleDocumentChange(event);
    }),
    {
      dispose: () => {
        void controller.stop();
      },
    },
  );

  try {
    await controller.start();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    output.appendLine(`[docassemble-lsp] Initial start failed: ${message}`);
  }

  controller.handleActiveEditorChange(vscode.window.activeTextEditor);

  return {
    restart: () => controller.restart(),
    showOutput: () => controller.showOutput(),
    showSetupHelp: () => controller.showSetupHelp(),
    getServerState: () => controller.getServerState(),
  };
}

export async function deactivate(): Promise<void> {
  if (!activeController) {
    return;
  }

  const controller = activeController;
  activeController = undefined;
  await controller.stop();
}
