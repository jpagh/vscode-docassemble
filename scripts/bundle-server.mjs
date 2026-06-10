import {
  cpSync,
  existsSync,
  rmSync,
  writeFileSync,
  readFileSync,
  mkdirSync,
  readdirSync,
} from "fs";
import { execSync } from "child_process";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");
const lspRoot = join(root, "..", "lsp");
const bundledDir = join(root, "bundled");
const bundledTool = join(bundledDir, "tool", "docassemble_lsp");

// 1) Copy Python tool source
if (existsSync(bundledTool)) {
  rmSync(bundledTool, { recursive: true });
}
cpSync(join(lspRoot, "src", "docassemble_lsp"), bundledTool, { recursive: true });

// 2) Generate run_server.py entry point
const entryPoint = [
  "from __future__ import annotations",
  "",
  "import os",
  "import sys",
  "from pathlib import Path",
  "",
  "BUNDLE_DIR = Path(__file__).resolve().parent",
  "",
  'TOOL_DIR = BUNDLE_DIR / "tool"',
  "sys.path.insert(0, str(TOOL_DIR))",
  "",
  'LIBS_DIR = BUNDLE_DIR / "libs"',
  "if LIBS_DIR.is_dir():",
  "    sys.path.insert(0, str(LIBS_DIR))",
  "",
  "from docassemble_lsp.lsp.server import run_server",
  "",
  'log_level = os.environ.get("DOCASSEMBLE_LSP_LOG_LEVEL", "WARNING")',
  "run_server(log_level=log_level)",
  "",
].join("\n");
writeFileSync(join(bundledDir, "run_server.py"), entryPoint);

// 3) Parse dependencies and version from pyproject.toml
const pyproject = readFileSync(join(lspRoot, "pyproject.toml"), "utf-8");

const versionMatch = pyproject.match(/^\s*version\s*=\s*"([^"]+)"/m);
const lspVersion = versionMatch ? versionMatch[1] : "unknown";
writeFileSync(join(bundledDir, "bundled-lsp-version.txt"), lspVersion + "\n");

const depsMatch = pyproject.match(/dependencies\s*=\s*\[([\s\S]*?)\]/m);
const deps = depsMatch
  ? depsMatch[1]
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.startsWith('"'))
      // Strip version constraints — keep the package name and minimum version only
      .map((l) => l.replace(/^"([^";]*?)(?:;\s*[^"]*)?"[,\s]*$/, "$1"))
  : [];
const reqFile = join(bundledDir, "requirements.txt");
writeFileSync(reqFile, deps.join("\n") + "\n");

// 4) Install dependencies into bundled/libs/
const libsDir = join(bundledDir, "libs");
if (!existsSync(libsDir)) {
  mkdirSync(libsDir, { recursive: true });
}

const runPip = (command) => {
  execSync(command, { stdio: "inherit", timeout: 120000 });
};

try {
  console.log("Installing dependencies with uv...");
  runPip(`uv pip install --target "${libsDir}" -r "${reqFile}"`);
} catch {
  console.log("uv not available, falling back to pip...");
  runPip(`python3 -m pip install --target "${libsDir}" -r "${reqFile}" --no-input --quiet`);
}

// Remove ruamel-yaml-clib (pure Python fallback is sufficient)
for (const entry of readdirSync(libsDir)) {
  const full = join(libsDir, entry);
  if (entry === "ruamel_yaml_clib" || entry === "ruamel.yaml.clib") {
    rmSync(full, { recursive: true });
    console.log(`  removed ${entry}`);
  } else if (/ruamel[_\-]yaml[_\-]clib/.test(entry) && /\.(so|dylib|pyd)$/.test(entry)) {
    rmSync(full);
    console.log(`  removed ${entry}`);
  }
}

console.log(
  `Bundled docassemble_lsp v${lspVersion} into vscode/bundled/ (${deps.length} dependencies)`,
);
