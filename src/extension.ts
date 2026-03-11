import * as vscode from "vscode";
import schema from "../schema.json";

interface SchemaProperty {
  $ref?: string;
  type?: string | string[];
  description?: string;
  $comment?: string;
  oneOf?: SchemaProperty[];
  anyOf?: SchemaProperty[];
  properties?: Record<string, SchemaProperty>;
  items?: SchemaProperty;
  enum?: unknown[];
  [key: string]: unknown;
}

const schemaDocument = schema as {
  properties: Record<string, SchemaProperty>;
  $defs?: Record<string, SchemaProperty>;
};

const properties = schemaDocument.properties;
const definitions = schemaDocument.$defs ?? {};
const fieldItemProperties = (definitions.fieldItem as SchemaProperty | undefined)?.properties ?? {};
const needItemProperties =
  (definitions.needPrePostItem as SchemaProperty | undefined)?.properties ?? {};

const actionButtonsProp = properties["action buttons"];
const actionButtonItemProperties =
  resolveProperty(
    ((actionButtonsProp?.anyOf?.[0] as SchemaProperty | undefined)?.items ?? {}) as SchemaProperty,
  ).properties ?? {};

const showIfModifierProp = definitions.showIfFieldModifier as SchemaProperty | undefined;
const showIfModifierProperties: Record<string, SchemaProperty> = {};
for (const variant of showIfModifierProp?.oneOf ?? []) {
  const resolved = resolveProperty(variant);
  if (resolved.type === "object" && resolved.properties) {
    Object.assign(showIfModifierProperties, resolved.properties);
  }
}

function resolveProperty(prop: SchemaProperty): SchemaProperty {
  if (!prop.$ref?.startsWith("#/$defs/")) {
    return prop;
  }

  const definitionName = prop.$ref.slice("#/$defs/".length);
  const resolved = definitions[definitionName];
  if (!resolved) {
    return prop;
  }

  return {
    ...resolved,
    ...prop,
  };
}

function getPropertyType(prop: SchemaProperty): string {
  const resolvedProp = resolveProperty(prop);

  if (resolvedProp.type) {
    return Array.isArray(resolvedProp.type) ? resolvedProp.type.join(" | ") : resolvedProp.type;
  }
  if (resolvedProp.oneOf) {
    const types = [
      ...new Set(
        resolvedProp.oneOf
          .map((variant) => resolveProperty(variant).type ?? "object")
          .filter(Boolean),
      ),
    ];
    return types.join(" | ");
  }
  if (resolvedProp.anyOf) {
    const types = [
      ...new Set(
        resolvedProp.anyOf
          .map((variant) => resolveProperty(variant).type ?? "object")
          .filter(Boolean),
      ),
    ];
    return types.join(" | ");
  }
  return "any";
}

function getEnumValues(prop: SchemaProperty): string[] {
  const resolvedProp = resolveProperty(prop);
  const values = new Set<string>();

  if (Array.isArray(resolvedProp.enum)) {
    for (const value of resolvedProp.enum) {
      if (typeof value === "string") values.add(value);
    }
  }

  const variants = [...(resolvedProp.oneOf ?? []), ...(resolvedProp.anyOf ?? [])];
  for (const variant of variants) {
    const resolvedVariant = resolveProperty(variant);
    if (Array.isArray(resolvedVariant.enum)) {
      for (const value of resolvedVariant.enum) {
        if (typeof value === "string") values.add(value);
      }
    }
    const constValue = resolvedVariant["const"];
    if (typeof constValue === "string") {
      values.add(constValue);
    }
  }

  return Array.from(values);
}

function getInsertText(name: string, prop: SchemaProperty): vscode.SnippetString {
  const resolvedProp = resolveProperty(prop);

  const isDefinitelyObject =
    resolvedProp.type === "object" ||
    (resolvedProp.oneOf?.length === 1 &&
      resolveProperty(resolvedProp.oneOf[0]).type === "object") ||
    (resolvedProp.anyOf?.length === 1 && resolveProperty(resolvedProp.anyOf[0]).type === "object");

  const isDefinitelyArray =
    resolvedProp.type === "array" ||
    (resolvedProp.oneOf?.length === 1 && resolveProperty(resolvedProp.oneOf[0]).type === "array") ||
    (resolvedProp.anyOf?.length === 1 && resolveProperty(resolvedProp.anyOf[0]).type === "array");

  if (isDefinitelyObject) {
    return new vscode.SnippetString(`${name}:\n  $0`);
  }
  if (isDefinitelyArray) {
    return new vscode.SnippetString(`${name}:\n  - $0`);
  }
  return new vscode.SnippetString(`${name}: $0`);
}

function getDocumentation(name: string, prop: SchemaProperty): vscode.MarkdownString | undefined {
  const resolvedProp = resolveProperty(prop);
  const parts: string[] = [];

  if (resolvedProp.description && resolvedProp.description !== "var") {
    parts.push(resolvedProp.description);
  }

  const comment = resolvedProp.$comment as string | undefined;
  if (comment) {
    const urlMatch = comment.match(/https?:\/\/\S+/);
    if (urlMatch) {
      parts.push(`[Docassemble Documentation](${urlMatch[0]})`);
    } else {
      parts.push(comment);
    }
  }

  const enumValues = getEnumValues(prop);
  if (enumValues.length) {
    parts.push(`Allowed values: \`${enumValues.join("`, `")}\``);
  }

  if (!parts.length) return undefined;
  const md = new vscode.MarkdownString(parts.join("\n\n"));
  md.isTrusted = true;
  return md;
}

function getLineIndent(text: string): number {
  const match = text.match(/^(\s*)/);
  return match ? match[1].length : 0;
}

type CompletionScope =
  | "topLevel"
  | "fieldsItem"
  | "actionButtonItem"
  | "needItem"
  | "showIfModifier";

function getAncestorKeys(document: vscode.TextDocument, position: vscode.Position): string[] {
  const currentIndent = getLineIndent(document.lineAt(position.line).text);
  let searchIndent = currentIndent;
  const ancestors: string[] = [];

  for (let line = position.line - 1; line >= 0; line--) {
    const text = document.lineAt(line).text;
    if (/^\s*(#.*)?$/.test(text)) continue;

    const indent = getLineIndent(text);
    if (indent >= searchIndent) continue;

    const keyMatch = text.match(/^\s*([\w][\w ]*?)\s*:/);
    if (keyMatch) {
      ancestors.push(keyMatch[1]);
    }

    searchIndent = indent;
  }

  return ancestors;
}

function getCompletionScope(
  document: vscode.TextDocument,
  position: vscode.Position,
): CompletionScope {
  const ancestors = getAncestorKeys(document, position);
  const nearest = ancestors[0];

  if (
    nearest === "show if" ||
    nearest === "hide if" ||
    nearest === "enable if" ||
    nearest === "disable if"
  ) {
    return "showIfModifier";
  }
  if (ancestors.includes("fields")) {
    return "fieldsItem";
  }
  if (ancestors.includes("action buttons")) {
    return "actionButtonItem";
  }
  if (ancestors.includes("need")) {
    return "needItem";
  }
  return "topLevel";
}

export function activate(context: vscode.ExtensionContext): void {
  const topLevelProperties = new Map<string, SchemaProperty>(Object.entries(properties));
  const fieldProperties = new Map<string, SchemaProperty>(Object.entries(fieldItemProperties));
  const actionButtonProperties = new Map<string, SchemaProperty>(
    Object.entries(actionButtonItemProperties),
  );
  const needProperties = new Map<string, SchemaProperty>(Object.entries(needItemProperties));
  const showIfProperties = new Map<string, SchemaProperty>(
    Object.entries(showIfModifierProperties),
  );

  const scopedProperties: Record<CompletionScope, Map<string, SchemaProperty>> = {
    topLevel: topLevelProperties,
    fieldsItem: fieldProperties,
    actionButtonItem: actionButtonProperties,
    needItem: needProperties,
    showIfModifier: showIfProperties,
  };

  const allKnownProperties = new Map<string, SchemaProperty>();
  for (const map of Object.values(scopedProperties)) {
    for (const [key, value] of map.entries()) {
      if (!allKnownProperties.has(key)) {
        allKnownProperties.set(key, value);
      }
    }
  }

  function completionItemsForScope(scope: CompletionScope): vscode.CompletionItem[] {
    return Array.from(scopedProperties[scope].entries()).map(([name, prop]) => {
      const item = new vscode.CompletionItem(name, vscode.CompletionItemKind.Property);
      item.insertText = getInsertText(name, prop);
      item.detail = getPropertyType(prop);
      item.documentation = getDocumentation(name, prop);
      item.filterText = name;
      return item;
    });
  }

  const completionProvider = vscode.languages.registerCompletionItemProvider(
    { language: "docassemble" },
    {
      provideCompletionItems(document, position) {
        const scope = getCompletionScope(document, position);
        const scopeProperties = scopedProperties[scope];
        const linePrefix = document.lineAt(position).text.slice(0, position.character);

        const valueMatch = linePrefix.match(/^(\s*)(?:-\s*)?([\w][\w ]*?)\s*:\s*([^\s#]*)$/);
        if (valueMatch) {
          const key = valueMatch[2];
          const partialValue = valueMatch[3];
          const prop = scopeProperties.get(key) ?? allKnownProperties.get(key);
          if (prop) {
            const enumValues = getEnumValues(prop);
            if (enumValues.length) {
              return enumValues
                .filter((value) => value.startsWith(partialValue))
                .map((value) => {
                  const item = new vscode.CompletionItem(value, vscode.CompletionItemKind.Value);
                  item.insertText = value;
                  item.range = new vscode.Range(
                    position.translate(0, -partialValue.length),
                    position,
                  );
                  return item;
                });
            }
          }
        }

        // Only offer key completions when the line so far is whitespace + word chars
        if (!/^\s*(?:-\s*)?[\w][\w ]*$/.test(linePrefix) && !/^\s*(?:-\s*)?$/.test(linePrefix)) {
          return undefined;
        }
        return completionItemsForScope(scope);
      },
    },
  );

  const hoverProvider = vscode.languages.registerHoverProvider(
    { language: "docassemble" },
    {
      provideHover(document, position) {
        const scope = getCompletionScope(document, position);
        const scopeProperties = scopedProperties[scope];
        const line = document.lineAt(position).text;
        // Match a YAML key: optional indent, then word chars/spaces, then colon
        const keyMatch = line.match(/^(\s*(?:-\s*)?)([\w][\w ]*?)(\s*:)/);
        if (!keyMatch) return undefined;

        const indent = keyMatch[1].length;
        const key = keyMatch[2];
        const keyEnd = indent + key.length;

        if (position.character < indent || position.character > keyEnd) {
          return undefined;
        }

        const prop = scopeProperties.get(key) ?? allKnownProperties.get(key);
        if (!prop) return undefined;

        const resolvedProp = resolveProperty(prop);

        const typeLine = `**${key}** \`${getPropertyType(prop)}\``;
        const parts: string[] = [typeLine];

        if (resolvedProp.description && resolvedProp.description !== "var") {
          parts.push(resolvedProp.description);
        }

        const comment = resolvedProp.$comment as string | undefined;
        if (comment) {
          const urlMatch = comment.match(/https?:\/\/\S+/);
          if (urlMatch) {
            parts.push(`[Docassemble Documentation](${urlMatch[0]})`);
          } else {
            parts.push(comment);
          }
        }

        const enumValues = getEnumValues(prop);
        if (enumValues.length) {
          parts.push(`Allowed values: \`${enumValues.join("`, `")}\``);
        }

        const md = new vscode.MarkdownString(parts.join("\n\n"));
        md.isTrusted = true;
        return new vscode.Hover(md);
      },
    },
  );

  context.subscriptions.push(completionProvider, hoverProvider);
}

export function deactivate(): void {}
