#!/usr/bin/env node

import Ajv from "ajv";
import * as fs from "fs";
import * as path from "path";
import * as url from "url";
import YAML from "yaml";

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));

const args = process.argv.slice(2);
const showHelp = args.includes("--help") || args.includes("-h");
const outputJson = args.includes("--json");
const recursive = args.includes("--recursive") || args.includes("-r");
const verbose = args.includes("--verbose") || args.includes("-v");
const allowNonBlocks = args.includes("--allow-non-blocks");

if (showHelp) {
  console.log(`
Usage: node validate.mjs [options] [files/directories...]

Options:
  --help, -h          Show this help message
  --json              Output results as JSON instead of human-readable format
  --recursive, -r     Recursively search directories for .yml files
  --verbose, -v       Show detailed error information and diagnostics
  --allow-non-blocks  Don't fail on documents that aren't docassemble blocks

Examples:
  node validate.mjs path/to/file.yml
  node validate.mjs path/to/directory --recursive
  node validate.mjs file1.yml --verbose
  node validate.mjs file1.yml --allow-non-blocks
  `);
  process.exit(0);
}

const schemaPaths = args.filter((arg) => !arg.startsWith("--") && !arg.startsWith("-"));

if (schemaPaths.length === 0) {
  console.error("Error: No files or directories specified");
  console.error("Use --help for usage information");
  process.exit(1);
}

// Load schema
const schemaPath = path.join(__dirname, "schema.json");
const schemaContent = fs.readFileSync(schemaPath, "utf-8");
const schema = JSON.parse(schemaContent);

// Initialize AJV with permissive settings
const ajv = new Ajv({
  allowUnionTypes: true,
  strict: false,
  useDefaults: true,
  loadSchema: async (uri) => {
    // Handle meta-schema references
    if (uri === "https://json-schema.org/draft/2020-12/schema") {
      return {
        $schema: "https://json-schema.org/draft/2020-12/schema",
        $id: "https://json-schema.org/draft/2020-12/schema",
        type: "object",
      };
    }
    throw new Error(`Unknown schema: ${uri}`);
  },
});

// Compile the schema (remove $schema reference to avoid meta-schema issues)
const compiledSchema = { ...schema };
delete compiledSchema.$schema;

const validate = ajv.compile(compiledSchema);

/**
 * Collect all YAML files from a list of file/directory paths
 */
function collectYamlFiles(paths, recurse) {
  const files = [];

  for (const filePath of paths) {
    const resolvedPath = path.resolve(filePath);

    if (!fs.existsSync(resolvedPath)) {
      console.error(`Warning: Path does not exist: ${filePath}`);
      continue;
    }

    const stat = fs.statSync(resolvedPath);

    if (stat.isFile()) {
      if (resolvedPath.endsWith(".yml") || resolvedPath.endsWith(".yaml")) {
        files.push(resolvedPath);
      }
    } else if (stat.isDirectory()) {
      if (recurse) {
        walkDir(resolvedPath, files);
      } else {
        const dirFiles = fs.readdirSync(resolvedPath);
        for (const file of dirFiles) {
          if (file.endsWith(".yml") || file.endsWith(".yaml")) {
            files.push(path.join(resolvedPath, file));
          }
        }
      }
    }
  }

  return files;
}

/**
 * Recursively walk directory and collect YAML files
 */
function walkDir(dir, files) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walkDir(fullPath, files);
    } else if (entry.name.endsWith(".yml") || entry.name.endsWith(".yaml")) {
      files.push(fullPath);
    }
  }
}

/**
 * Validate a single YAML file
 */
function validateFile(filePath) {
  const result = {
    file: filePath,
    valid: false,
    errors: [],
    data: null,
    documentCount: 0,
    documentTypes: [],
  };

  try {
    const content = fs.readFileSync(filePath, "utf-8");

    // Parse YAML - handle both single and multi-document files
    const documents = YAML.parseAllDocuments(content).map((doc) => doc.toJS());
    result.documentCount = documents.length;

    // If it's a single document, unwrap it
    const parsedData = documents.length === 1 ? documents[0] : documents;
    result.data = parsedData;

    // Validate each document (if array) or single document
    const documentsToValidate = Array.isArray(parsedData) ? parsedData : [parsedData];
    const allErrors = [];

    for (let i = 0; i < documentsToValidate.length; i++) {
      const doc = documentsToValidate[i];
      const docType = detectDocumentType(doc);
      result.documentTypes.push(docType);

      // Skip non-block documents if allowed
      if (
        allowNonBlocks &&
        docType !== "question-block" &&
        docType !== "code-block" &&
        docType !== "template-block"
      ) {
        if (verbose) {
          console.log(`  [SKIP] Document ${i + 1}/${documentsToValidate.length}: ${docType}`);
        }
        continue;
      }

      if (!validate(doc)) {
        const docErrors = formatErrors(validate.errors || [], doc).map((err) => ({
          ...err,
          documentIndex: documentsToValidate.length > 1 ? i : undefined,
          documentType: docType,
          documentKeys: Object.keys(doc || {}),
        }));
        allErrors.push(...docErrors);
      }
    }

    if (allErrors.length > 0) {
      result.errors = allErrors;
    } else {
      result.valid = true;
    }
  } catch (error) {
    result.errors = [
      {
        level: "error",
        message: error instanceof Error ? error.message : String(error),
        type: "parse-error",
      },
    ];
  }

  return result;
}

/**
 * Detect what type of document this is
 */
function detectDocumentType(doc) {
  if (typeof doc !== "object" || doc === null) {
    return "non-object";
  }

  const keys = Object.keys(doc);

  if (keys.includes("question")) return "question-block";
  if (keys.includes("code")) return "code-block";
  if (keys.includes("template")) return "template-block";
  if (keys.includes("modules")) return "modules-declaration";
  if (keys.includes("include")) return "include-declaration";
  if (keys.length === 0) return "empty-document";

  // Jinja/Mako templates are complex - check for macro or template syntax
  const docStr = JSON.stringify(doc);
  if (docStr.includes("{%") || docStr.includes("{#")) return "jinja-template";
  if (docStr.includes("<%") || docStr.includes("<%")) return "mako-template";

  return "unknown-block";
}

/**
 * Format AJV validation errors into a readable format
 */
function formatErrors(errors, doc) {
  if (!errors || !Array.isArray(errors)) {
    return [];
  }

  return errors.map((error) => {
    let message = ajv.errorsText([error]);

    // Improve error messages for common constraint violations
    if (error.keyword === "not") {
      message =
        "Property combination not allowed (e.g., subject field not allowed in question blocks)";
    } else if (error.keyword === "unevaluatedProperties") {
      message = `Unknown property '${error.params?.unevaluatedProperty}' in this block type`;
    }

    return {
      level: "error",
      message: message,
      instancePath: error.instancePath || "/",
      schemaPath: error.schemaPath,
      keyword: error.keyword,
      type: "validation-error",
    };
  });
}

/**
 * Format validation results for human-readable output
 */
function formatHumanReadable(results) {
  let output = "\n";
  let totalFiles = results.length;
  let validFiles = results.filter((r) => r.valid).length;
  let invalidFiles = totalFiles - validFiles;

  for (const result of results) {
    const status = result.valid ? "✓" : "✗";
    output += `${status} ${result.file}`;

    if (result.documentCount && result.documentCount > 1) {
      output += ` (${result.documentCount} documents: ${result.documentTypes?.join(", ")})`;
    } else if (result.documentTypes?.length === 1) {
      output += ` [${result.documentTypes[0]}]`;
    }

    output += "\n";

    if (!result.valid && result.errors.length > 0) {
      for (const error of result.errors) {
        output += `  [${error.level.toUpperCase()}] ${error.message}\n`;

        if (verbose) {
          if (error.documentIndex !== undefined) {
            output += `    at document ${error.documentIndex + 1}\n`;
          }
          if (error.documentType && error.documentType !== "unknown-block") {
            output += `    document type: ${error.documentType}\n`;
          }
          if (error.documentKeys && error.documentKeys.length > 0) {
            output += `    properties: ${error.documentKeys.slice(0, 5).join(", ")}${error.documentKeys.length > 5 ? "..." : ""}\n`;
          }
        }

        if (error.instancePath && error.instancePath !== "/") {
          output += `    at ${error.instancePath}\n`;
        }
      }
    }
  }

  output += `\n${"=".repeat(60)}\n`;
  output += `Summary: ${validFiles}/${totalFiles} files valid\n`;
  if (invalidFiles > 0) {
    output += `${invalidFiles} file(s) with errors\n`;
  }
  if (allowNonBlocks) {
    output += "(Non-block documents skipped)\n";
  }
  output += `${"=".repeat(60)}\n`;

  if (!allowNonBlocks && invalidFiles > 0) {
    output += `\nTip: Use --allow-non-blocks to skip module/include declarations\n`;
    output += `and other non-docassemble-block documents.\n`;
  }

  return output;
}

// Main execution
try {
  const yamlFiles = collectYamlFiles(schemaPaths, recursive);

  if (yamlFiles.length === 0) {
    console.error("Error: No YAML files found");
    process.exit(1);
  }

  const results = yamlFiles.map((file) => validateFile(file));

  if (outputJson) {
    console.log(JSON.stringify(results, null, 2));
  } else {
    console.log(formatHumanReadable(results));
  }

  const hasErrors = results.some((r) => !r.valid);
  process.exit(hasErrors ? 1 : 0);
} catch (error) {
  console.error("Fatal error:", error instanceof Error ? error.message : String(error));
  process.exit(1);
}
