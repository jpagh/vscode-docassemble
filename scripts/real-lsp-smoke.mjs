import { spawn, spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..");
const fixturePath = path.join(repoRoot, "test-fixtures", "real-lsp-smoke.yml");

run().catch((error) => {
  console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
  process.exitCode = 1;
});

async function run() {
  assertCommandAvailable();
  runCheckCommand();
  await probeInitialize();
  console.log("real docassemble-lsp smoke test passed");
}

function assertCommandAvailable() {
  const result = spawnSync("docassemble-lsp", ["--help"], {
    encoding: "utf8",
  });

  if (result.error) {
    throw new Error(`Could not execute docassemble-lsp: ${result.error.message}`);
  }

  if (result.status !== 0) {
    throw new Error(result.stderr.trim() || "docassemble-lsp --help failed");
  }
}

function runCheckCommand() {
  const result = spawnSync("docassemble-lsp", ["check", fixturePath], {
    encoding: "utf8",
  });

  if (result.error) {
    throw new Error(`docassemble-lsp check failed to start: ${result.error.message}`);
  }

  if (result.status !== 0) {
    throw new Error(result.stdout.trim() || result.stderr.trim() || "docassemble-lsp check failed");
  }
}

async function probeInitialize() {
  const child = spawn("docassemble-lsp", ["lsp"], {
    stdio: ["pipe", "pipe", "pipe"],
  });

  let stderr = "";
  let buffer = Buffer.alloc(0);

  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString("utf8");
  });

  const responsePromise = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      child.kill();
      reject(
        new Error(
          `Timed out waiting for initialize response.${stderr ? ` stderr: ${stderr.trim()}` : ""}`,
        ),
      );
    }, 5000);

    child.stdout.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      const marker = Buffer.from("\r\n\r\n");
      const headerEnd = buffer.indexOf(marker);
      if (headerEnd === -1) {
        return;
      }

      const headerText = buffer.subarray(0, headerEnd).toString("utf8");
      const match = /Content-Length:\s*(\d+)/i.exec(headerText);
      if (!match) {
        return;
      }

      const contentLength = Number(match[1]);
      const messageEnd = headerEnd + marker.length + contentLength;
      if (buffer.length < messageEnd) {
        return;
      }

      clearTimeout(timeout);
      const body = buffer.subarray(headerEnd + marker.length, messageEnd).toString("utf8");
      resolve(JSON.parse(body));
    });

    child.on("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });

    child.on("exit", (code) => {
      if (code && code !== 0) {
        clearTimeout(timeout);
        reject(new Error(stderr.trim() || `docassemble-lsp lsp exited with code ${code}`));
      }
    });
  });

  const request = {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      processId: null,
      rootUri: null,
      capabilities: {},
      clientInfo: { name: "real-lsp-smoke" },
    },
  };

  writeMessage(child, request);

  const response = await responsePromise;
  const capabilities = response?.result?.capabilities;
  if (!capabilities) {
    throw new Error("Initialize response did not include capabilities");
  }

  writeMessage(child, { jsonrpc: "2.0", id: 2, method: "shutdown", params: null });
  child.stdin.end(encodeMessage({ jsonrpc: "2.0", method: "exit", params: null }));
}

function writeMessage(child, payload) {
  child.stdin.write(encodeMessage(payload));
}

function encodeMessage(payload) {
  const body = Buffer.from(JSON.stringify(payload), "utf8");
  const header = Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, "utf8");
  return Buffer.concat([header, body]);
}
