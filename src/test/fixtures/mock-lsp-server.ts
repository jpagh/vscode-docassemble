import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as process from "node:process";

type JsonRpcMessage = {
  id?: number | string;
  method?: string;
  params?: {
    ch?: string;
    contentChanges?: Array<{ text: string }>;
    position?: {
      line: number;
      character: number;
    };
    textDocument?: {
      uri: string;
      text?: string;
    };
  };
};

type Diagnostic = {
  range: {
    start: { line: number; character: number };
    end: { line: number; character: number };
  };
  severity: number;
  message: string;
  source: string;
};

let buffer = Buffer.alloc(0);
const logPath = process.env.DOCASSEMBLE_MOCK_LOG?.trim();

process.stdin.on("data", (chunk: Buffer) => {
  buffer = Buffer.concat([buffer, chunk]);

  while (true) {
    const headerEnd = buffer.indexOf("\r\n\r\n");
    if (headerEnd === -1) {
      return;
    }

    const headerText = buffer.subarray(0, headerEnd).toString("utf8");
    const contentLengthHeader = headerText
      .split("\r\n")
      .find((line) => line.toLowerCase().startsWith("content-length:"));

    if (!contentLengthHeader) {
      process.exit(1);
      return;
    }

    const contentLength = Number.parseInt(contentLengthHeader.split(":")[1]?.trim() ?? "", 10);
    const messageEnd = headerEnd + 4 + contentLength;
    if (buffer.length < messageEnd) {
      return;
    }

    const body = buffer.subarray(headerEnd + 4, messageEnd).toString("utf8");
    buffer = buffer.subarray(messageEnd);
    handleMessage(JSON.parse(body) as JsonRpcMessage);
  }
});

process.stdin.resume();

function handleMessage(message: JsonRpcMessage): void {
  logMessage(message.method);

  if (message.method === "initialize") {
    send({
      jsonrpc: "2.0",
      id: message.id,
      result: {
        capabilities: {
          textDocumentSync: 1,
          completionProvider: {},
          documentOnTypeFormattingProvider: {
            firstTriggerCharacter: "{",
          },
          hoverProvider: true,
        },
      },
    });
    return;
  }

  if (message.method === "textDocument/didOpen") {
    const uri = message.params?.textDocument?.uri;
    const text = message.params?.textDocument?.text;
    if (uri && typeof text === "string") {
      publishDiagnostics(uri, text);
    }
    return;
  }

  if (message.method === "textDocument/didChange") {
    const uri = message.params?.textDocument?.uri;
    const text = message.params?.contentChanges?.at(-1)?.text;
    if (uri && typeof text === "string") {
      publishDiagnostics(uri, text);
    }
    return;
  }

  if (message.method === "textDocument/onTypeFormatting") {
    send({
      jsonrpc: "2.0",
      id: message.id,
      result:
        message.params?.ch === "{"
          ? [
              {
                range: {
                  start: message.params.position,
                  end: message.params.position,
                },
                newText: "FORMATTED",
              },
            ]
          : [],
    });
    return;
  }

  if (message.method === "shutdown") {
    send({
      jsonrpc: "2.0",
      id: message.id,
      result: null,
    });
    return;
  }

  if (message.method === "exit") {
    process.exit(0);
    return;
  }

  if (typeof message.id !== "undefined") {
    send({
      jsonrpc: "2.0",
      id: message.id,
      result: null,
    });
  }
}

function send(payload: object): void {
  const body = Buffer.from(JSON.stringify(payload), "utf8");
  process.stdout.write(`Content-Length: ${body.length}\r\n\r\n`);
  process.stdout.write(body);
}

function publishDiagnostics(uri: string, text: string): void {
  const diagnostics: Diagnostic[] = [];
  const match = text.match(/mock diagnostic/i);

  if (match) {
    diagnostics.push({
      range: {
        start: { line: 0, character: match.index ?? 0 },
        end: { line: 0, character: (match.index ?? 0) + match[0].length },
      },
      severity: 1,
      message: "Mock diagnostic",
      source: "docassemble-mock",
    });
  }

  send({
    jsonrpc: "2.0",
    method: "textDocument/publishDiagnostics",
    params: {
      uri,
      diagnostics,
    },
  });
}

function logMessage(method: string | undefined): void {
  if (!logPath || !method) {
    return;
  }

  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  fs.appendFileSync(logPath, `${method}${os.EOL}`, "utf8");
}
