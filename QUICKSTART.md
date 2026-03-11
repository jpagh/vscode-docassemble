# Quick Start Guide - Schema Validation

## Installation

```bash
npm install
```

## Common Commands

### Validate a single file
```bash
node validate.mjs interview.yml
```

### Validate all files in a directory
```bash
node validate.mjs ./interviews --recursive
```

### Get JSON output for scripting
```bash
node validate.mjs ./interviews --recursive --json > results.json
```

### Use npm shortcut
```bash
npm run validate -- ./interviews -r
```

### Test with sample files
```bash
npm run validate:test
```

## Understanding Error Output

### Example: Invalid progress value
```
✗ invalid_progress.yml
  [ERROR] data/progress must be <= 100
    at /progress
```

- `[ERROR]` = validation constraint violation
- `data/progress must be <= 100` = what failed (progress must be 0-100)
- `at /progress` = where in the YAML it failed

### Example: Schema conflict
```
✗ invalid_subject_in_question.yml
  [ERROR] data must NOT be valid
    at /
```

- The schema has a rule that blocks can't have certain field combinations
- In this case: `subject` field is not allowed in `question` blocks (use in template blocks)

## Common Validation Errors

| Error | Meaning | Solution |
|-------|---------|----------|
| `must be <= 100` | Progress value over 100 | Lower progress value to 0-100 |
| `must NOT be valid` | Property combination not allowed | Check schema rules (e.g., subject in templates only) |
| `type: parse-error` | Invalid YAML syntax | Check YAML indentation and format |
| `missing required property` | Missing mandatory field | Add the required field |

## Exit Codes

- **0** = All files valid ✓
- **1** = One or more files invalid ✗

Useful for CI/CD pipelines:
```bash
npm run validate -- ./interviews -r || exit 1
```

## Add to Your Workflow

### As a pre-commit hook
```bash
#!/bin/sh
node validate.mjs . -r
```

### In CI/CD (GitHub Actions example)
```yaml
- name: Validate Docassemble YAML
  run: npm run validate -- ./interviews -r
```

### As part of npm test
Update `package.json`:
```json
{
  "scripts": {
    "test": "npm run validate -- ./interviews -r"
  }
}
```
