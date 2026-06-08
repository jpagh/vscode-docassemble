import * as vscode from "vscode";
import {
  FileChangeType,
  LanguageClient,
  RevealOutputChannelOn,
  ServerOptions,
  State as ClientState,
  Trace,
} from "vscode-languageclient/node";

const CONFIG_SECTION = "docassemble.lsp";
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
  env: NodeJS.ProcessEnv;
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

  public constructor(
    private readonly output: vscode.OutputChannel,
    private readonly statusBar: vscode.StatusBarItem,
  ) {
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
      await this.stopInternal();
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
      this.log("Language server startup skipped because docassemble.lsp.enabled is false.");
      return;
    }

    const resolvedCommand = this.resolveCommand(config);
    if (!resolvedCommand) {
      this.setServerState("missing");
      this.log(
        "Language server startup skipped because the configured command could not be resolved.",
      );
      return;
    }

    this.lastResolvedCommand = resolvedCommand.command;
    this.lastError = undefined;

    const serverOptions: ServerOptions = {
      command: resolvedCommand.command,
      args: [],
      options: {
        env: resolvedCommand.env,
        shell: true,
      },
    };

    const client = new LanguageClient(
      "docassemble-lsp",
      "Docassemble Language Server",
      serverOptions,
      {
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
    } catch {
      this.log("Language server stop timed out; proceeding with forced shutdown.");
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
      "[docassemble-lsp] Install `docassemble-lsp` on your PATH, or set `docassemble.lsp.command` to the full command you want VS Code to run.",
    );
    this.output.appendLine("[docassemble-lsp] Default command: docassemble-lsp lsp");
    this.output.appendLine(
      "[docassemble-lsp] Example command override: /path/to/venv/bin/python -m docassemble_lsp lsp",
    );
    this.output.appendLine(
      "[docassemble-lsp] Example uv project override: uv run --project /path/to/docassemble-lsp docassemble-lsp lsp",
    );

    const selection = await vscode.window.showInformationMessage(
      "Install docassemble-lsp on PATH or configure docassemble.lsp.command.",
      "Open Settings",
      "Show Output",
    );

    if (selection === "Open Settings") {
      await vscode.commands.executeCommand("workbench.action.openSettings", "docassemble.lsp");
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
      void this.restart();
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

  private resolveCommand(config: vscode.WorkspaceConfiguration): ResolvedCommand | undefined {
    const configuredEnv = config.get<Record<string, string>>("env", {});
    const resolvedEnv = {
      ...process.env,
      ...configuredEnv,
    };

    const configuredCommand = config.get<string>("command", "docassemble-lsp lsp").trim();
    if (!configuredCommand) {
      this.lastResolvedCommand = undefined;
      this.lastError = undefined;
      this.setServerState("missing");
      this.log("Language server startup skipped because docassemble.lsp.command is empty.");
      return undefined;
    }

    return {
      command: configuredCommand,
      env: resolvedEnv,
    };
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
          ? `${this.lastResolvedCommand} — click to restart`
          : "Docassemble LSP: click to restart";
        this.statusBar.command = "docassemble.lsp.restart";
        break;
      case "missing":
        this.statusBar.text = "$(warning) Docassemble LSP";
        this.statusBar.tooltip = "No Docassemble LSP command is configured. Click for setup help.";
        this.statusBar.command = "docassemble.lsp.showSetupHelp";
        break;
      case "disabled":
        this.statusBar.text = "$(circle-slash) Docassemble LSP";
        this.statusBar.tooltip = "Docassemble language server is disabled in settings.";
        this.statusBar.command = "docassemble.lsp.showSetupHelp";
        break;
      case "error":
        this.statusBar.text = "$(error) Docassemble LSP";
        this.statusBar.tooltip = this.lastError
          ? `Docassemble language server failed to start: ${this.lastError}`
          : "Docassemble language server failed to start.";
        this.statusBar.command = "docassemble.lsp.showOutput";
        break;
      case "stopped":
        this.statusBar.text = "$(debug-stop) Docassemble LSP";
        this.statusBar.tooltip = "Docassemble language server is stopped.";
        this.statusBar.command = "docassemble.lsp.restart";
        break;
      default:
        this.statusBar.text = "$(sync~spin) Docassemble LSP";
        this.statusBar.tooltip = "Docassemble language server is starting.";
        this.statusBar.command = "docassemble.lsp.showOutput";
        break;
    }

    this.statusBar.show();
  }
}

let activeController: DocassembleLspController | undefined;

export async function activate(context: vscode.ExtensionContext): Promise<DocassembleExtensionApi> {
  const output = vscode.window.createOutputChannel("Docassemble Language Server");
  const statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 10);
  statusBar.name = "Docassemble Language Server";
  const controller = new DocassembleLspController(output, statusBar);
  activeController = controller;

  context.subscriptions.push(
    output,
    statusBar,
    vscode.commands.registerCommand("docassemble.lsp.restart", async () => {
      await controller.restart();
    }),
    vscode.commands.registerCommand("docassemble.lsp.showOutput", () => {
      controller.showOutput();
    }),
    vscode.commands.registerCommand("docassemble.lsp.showSetupHelp", async () => {
      await controller.showSetupHelp();
    }),
    vscode.workspace.onDidChangeConfiguration(async (event) => {
      await controller.handleConfigurationChange(event);
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

  await controller.start();
  controller.handleActiveEditorChange(vscode.window.activeTextEditor);

  return {
    restart: async () => {
      await controller.restart();
    },
    showOutput: () => {
      controller.showOutput();
    },
    showSetupHelp: async () => {
      await controller.showSetupHelp();
    },
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
