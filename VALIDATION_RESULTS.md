# Docassemble YAML Validation Results

## Summary

**Files Validated:** 29  
**Files Valid:** 22 ✓  
**Files with Errors:** 7 ✗  

### How to Run Validation

```bash
cd /home/jack/projects/vscode-docassemble

# Basic validation
node validate.mjs ~/projects/docassemble-automatedpleading/docassemble/automatedpleading/data/questions --recursive

# Skip non-block documents (modules, includes, etc.)
node validate.mjs ~/projects/docassemble-automatedpleading/docassemble/automatedpleading/data/questions --recursive --allow-non-blocks

# Get detailed error information
node validate.mjs path/to/file.yml --verbose

# Export as JSON for analysis
node validate.mjs ~/projects/docassemble-automatedpleading/docassemble/automatedpleading/data/questions --recursive --allow-non-blocks --json > report.json
```

## Understanding "data must NOT be valid" Errors

When you see this error without `--allow-non-blocks`, it means:

1. **Empty YAML documents** - Files with multiple `---` separators sometimes create empty documents
2. **Non-docassemble blocks** - Files with module declarations, include statements, or Jinja templates
3. **Schema constraint violations** - A property combination isn't allowed

**Solution:** Use the `--allow-non-blocks` flag to skip non-docassemble blocks and focus on real errors.

## Files with Validation Errors (7 total)

### 1. **account_settings.yml**
   - 36 documents total
   - Contains: multiple unknown-block types
   - **Issue:** Likely has unknown/unsupported docassemble block types or custom structures

### 2. **basic_venue.yml**
   - 26 documents
   - **Issue:** Check field definitions for `datatype` values

### 3. **category_dept_of_revenue.yml**
   - 75 documents (largest file)
   - **Most likely issues:**
     - Invalid field `datatype` values
     - Missing or improperly formatted field definitions

### 4. **category_foreclosure.yml**
   - 38 documents
   - **Issue:** Field validation errors

### 5. **documents.yml**
   - 34 documents
   - **Issue:** Field or reconsider property format

### 6. **generic_questions.yml**
   - 57 documents
   - **Issue:** Field datatype or structure problems

### 7. **main.yml**
   - 15 documents
   - **Issue:** `reconsider` field format - should be string or array

## Common Validation Errors Explained

| Error | Meaning | Fix |
|-------|---------|-----|
| `data/fields/0/datatype must be equal to one of the allowed values` | Field has invalid datatype | Check schema for allowed values: user, camera, checkboxes, date, email, etc. |
| `data/fields must be object` | Fields defined as wrong type | Fields should be array of objects or object with code reference |
| `data/reconsider must be string` or `data/reconsider must be array` | Wrong format | Reconsider can be string (variable name) or array (list of variables) |
| `data/if must be string` | Conditional logic wrong format | Use string with Python code |

## Next Steps

1. **Run with verbose flag on a single file:**
   ```bash
   node validate.mjs ~/path/to/problem-file.yml --verbose
   ```

2. **Check the specific error messages** for the exact field/line causing issues

3. **Fix the YAML blocks** by updating field definitions or removing unsupported properties

4. **Re-run validation** to verify fixes

## Field Datatype Reference

Valid values for `datatype` in fields:
- `text`, `area`, `email`, `password`
- `date`, `datetime`, `time`
- `integer`, `number`, `currency`
- `yesno`, `noyes`, `yesnomaybe`, `noyesmaybe`
- `checkbox`, `radio`, `combobox`, `dropdown`, `multiselect`
- `file`, `files`, `camera`, `microphone`
- And more (see schema.json for complete list)

## Document Type Classifications

The validator categorizes YAML documents in multi-document files as:

- **question-block** - Valid question block
- **code-block** - Code/import block
- **template-block** - Template/email block
- **modules-declaration** - Module imports
- **include-declaration** - Include statements
- **unknown-block** - Unrecognized block type
- **non-object** - Empty document or comment-only section
- **jinja-template** - Jinja template macros
- **mako-template** - Mako template code

These non-block types can be safely ignored with `--allow-non-blocks`.
