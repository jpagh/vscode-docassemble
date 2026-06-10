import { readFileSync, writeFileSync } from "fs";
import { execSync } from "child_process";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");

const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf-8"));
const newVersion = pkg.version;

if (newVersion.includes("-")) {
  console.log(`Pre-release ${newVersion}; skipping CHANGELOG update`);
  process.exit(0);
}

const changelogPath = join(root, "CHANGELOG.md");
let changelog = readFileSync(changelogPath, "utf-8");

const today = new Date();
const dateStr = today.toISOString().slice(0, 10);

const unreleasedHeader = "## [Unreleased]";
if (!changelog.includes(unreleasedHeader)) {
  console.error("No [Unreleased] section found in CHANGELOG.md");
  process.exit(1);
}

changelog = changelog.replace(unreleasedHeader, `## [${newVersion}] - ${dateStr}`);

changelog = changelog.replace("# Changelog\n\n", `# Changelog\n\n## [Unreleased]\n\n`);

writeFileSync(changelogPath, changelog, "utf-8");

execSync("git add CHANGELOG.md", { cwd: root });

console.log(`CHANGELOG: [Unreleased] → [${newVersion}] - ${dateStr}`);
