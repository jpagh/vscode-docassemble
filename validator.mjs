#!/usr/bin/env node

/**
 * Example usage of the validation functions programmatically.
 * This shows how to integrate the validator into other Node.js projects.
 */

import Ajv from "ajv";
import * as fs from "fs";
import * as path from "path";
import * as url from "url";
import YAML from "yaml";

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));

// Load schema
const schemaPath = path.join(__dirname, "schema.json");
const schemaContent = fs.readFileSync(schemaPath, "utf-8");
const schema = JSON.parse(schemaContent);

// Initialize validator
const ajv = new Ajv({
  allowUnionTypes: true,
  strict: false,
  useDefaults: true,
});

const compiledSchema = { ...schema };
delete compiledSchema.$schema;
const validate = ajv.compile(compiledSchema);

/**
 * Validate YAML content and return errors
 * @param {string} yamlContent - YAML content as string
 * @returns {Object} Validation result with valid flag and errors array
 */
export function validateYamlContent(yamlContent) {
  try {
    const documents = YAML.parseAllDocuments(yamlContent).map((doc) => doc.toJS());
    const data = documents.length === 1 ? documents[0] : documents;

    const documentsToValidate = Array.isArray(data) ? data : [data];
    const allErrors = [];

    for (let i = 0; i < documentsToValidate.length; i++) {
      const doc = documentsToValidate[i];
      if (!validate(doc)) {
        const docErrors = (validate.errors || []).map((error) => ({
          level: "error",
          message: ajv.errorsText([error]),
          instancePath: error.instancePath || "/",
          schemaPath: error.schemaPath,
          keyword: error.keyword,
          type: "validation-error",
          documentIndex: documentsToValidate.length > 1 ? i : undefined,
        }));
        allErrors.push(...docErrors);
      }
    }

    return {
      valid: allErrors.length === 0,
      errors: allErrors,
      data,
    };
  } catch (error) {
    return {
      valid: false,
      errors: [
        {
          level: "error",
          message: error instanceof Error ? error.message : String(error),
          type: "parse-error",
        },
      ],
      data: null,
    };
  }
}

/**
 * Validate a YAML file
 * @param {string} filePath - Path to YAML file
 * @returns {Object} Validation result
 */
export function validateYamlFile(filePath) {
  const content = fs.readFileSync(filePath, "utf-8");
  return validateYamlContent(content);
}

// Example usage
if (process.argv[1] === url.fileURLToPath(import.meta.url)) {
  const testFile = "test-files/valid_simple_question.yml";
  console.log(`Validating: ${testFile}`);
  const result = validateYamlFile(testFile);
  console.log(JSON.stringify(result, null, 2));
}
