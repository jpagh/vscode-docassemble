# Docassemble YAML Schema Validation Tool

This tool validates docassemble YAML files against the `schema.json` file and provides detailed error and warning logging.

## Installation

Install dependencies:

```bash
npm install
```

This installs:
- **ajv**: JSON Schema validator
- **yaml**: YAML parser

## Usage

### Basic Validation

Validate a single file:

```bash
node validate.mjs path/to/file.yml
```

### Validate a Directory

Validate all `.yml` and `.yaml` files in a directory:

```bash
node validate.mjs path/to/directory
```

### Recursive Validation

Recursively search directories for YAML files:

```bash
node validate.mjs path/to/directory --recursive
```

Or using the short form:

```bash
node validate.mjs path/to/directory -r
```

### JSON Output

Get results as JSON (useful for programmatic processing):

```bash
node validate.mjs path/to/directory --recursive --json
```

### NPM Scripts

Convenient npm scripts are available:

```bash
# Validate as needed (define your own path)
npm run validate -- path/to/files

# Run validation on included test files
npm run validate:test
```

## Output Formats

### Human-Readable Output

```
✓ path/to/valid_file.yml
✗ path/to/invalid_file.yml
  [ERROR] instance.progress must be <= 100
    at /progress

============================================================
Summary: 1/2 files valid
1 file(s) with errors
============================================================
```

### JSON Output

```json
[
  {
    "file": "path/to/file.yml",
    "valid": true,
    "errors": [],
    "data": { ... }
  },
  {
    "file": "path/to/invalid.yml",
    "valid": false,
    "errors": [
      {
        "level": "error",
        "message": "instance.progress must be <= 100",
        "instancePath": "/progress",
        "schemaPath": "#/properties/progress/maximum",
        "keyword": "maximum",
        "type": "validation-error"
      }
    ],
    "data": null
  }
]
```

## Test Files

Sample test files are included in the `test-files/` directory:

- `valid_simple_question.yml` - Simple question block
- `valid_with_code.yml` - Question with Python code
- `valid_template.yml` - Template/email block
- `valid_complex.yml` - Complex multi-block interview
- `invalid_progress.yml` - Invalid progress value (>100)
- `invalid_subject_in_question.yml` - Subject field in question block (should be in template)

Run the test suite:

```bash
npm run validate:test
```

## Exit Codes

- `0` - All files validated successfully
- `1` - One or more files have validation errors
- `1` - Fatal error (file not found, parse error, etc.)

## Features

- **Permissive validation**: Allows properties not defined in schema to avoid false positives
- **Union type support**: Handles properties that accept multiple types
- **Detailed error reporting**: Shows exact location and schema constraint that failed
- **Bulk validation**: Process directories with recursive search
- **Multiple output formats**: Human-readable and JSON
- **YAML parsing**: Full YAML syntax support including anchors, aliases, etc.

## Schema Reference

The validation is based on [schema.json](../schema.json), which defines:

- Top-level blocks: question, code, sections, etc.
- Field types and modifiers
- Valid values and patterns
- Relationships between properties (e.g., `subject` only in templates, not questions)

## Programmatic Usage

You can import and use the validator in your own Node.js code:

```javascript
import { validateYamlFile, validateYamlContent } from './validator.mjs';

// Validate a file
const result = validateYamlFile('path/to/file.yml');
console.log(result.valid); // true or false
console.log(result.errors); // array of error objects
console.log(result.data); // parsed YAML data

// Validate YAML content directly
const content = `
question: Are you sure?
fields:
  - label: Yes or No
    field: user_choice
    datatype: yesno
`;
const result2 = validateYamlContent(content);
```

The validator returns an object with:
- `valid`: boolean indicating if validation passed
- `errors`: array of error objects with details
- `data`: parsed YAML data (null if parse error)

Each error contains:
- `level`: "error" or "warning"
- `message`: human-readable error description
- `instancePath`: JSON path to the invalid property
- `schemaPath`: path in the schema that failed
- `keyword`: the schema constraint name (e.g., "maximum")
- `type`: "validation-error" or "parse-error"
- `documentIndex`: document index if validating multi-document YAML
