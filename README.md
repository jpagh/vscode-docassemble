# Docassemble YAML

Provides syntax highlighting for [Docassemble](https://docassemble.org/) YAML files that incorporate Python, Mako, and Jinja.

The extension now also supports the external `docassemble-lsp` language server for diagnostics, completion, hover, definitions, references, rename, symbols, formatting, and code actions.

The language server is optional.

- If `docassemble-lsp` is available on your system `PATH`, the extension will try to start it automatically for Docassemble files.
- If it is not installed, the extension still works as a grammar-only syntax-highlighting extension.
- The extension does not bundle Python or `docassemble-lsp`.

## Install The Optional Language Server

Install `docassemble-lsp` in a Python environment that is available to VS Code.

The default startup command is:

```text
docassemble-lsp lsp
```

If you prefer to use a specific Python interpreter or virtual environment, point the extension at that command instead.

## Settings

The extension contributes these settings:

- `docassemble.lsp.enabled`: enable or disable the optional language server.
- `docassemble.lsp.command`: full command line to launch. Defaults to `docassemble-lsp lsp`.
- `docassemble.lsp.env`: extra environment variables for the server process.
- `docassemble.lsp.trace.server`: protocol trace level for debugging. When set to `messages` or `verbose`, the extension also logs client-side selector, Enter/newline, and on-type formatting diagnostics to the Docassemble Language Server output channel.

Example using the standard installed command:

```json
{
	"docassemble.lsp.command": "docassemble-lsp lsp"
}
```

Example using a specific Python interpreter:

```json
{
	"docassemble.lsp.command": "/path/to/venv/bin/python -m docassemble_lsp lsp"
}
```

Example using a local checkout through `uv run`:

```json
{
	"docassemble.lsp.command": "uv run --project ~/Projects/docassemble-lsp docassemble-lsp lsp"
}
```

## Commands

- `Docassemble: Restart Docassemble Language Server`
- `Docassemble: Show Docassemble Language Server Output`
- `Docassemble: Show Docassemble Language Server Setup Help`

## Notes

- This extension still associates `.yml` files with the `docassemble` language.
- On-type formatting only runs through the Docassemble LSP when the active document language id is `docassemble`. If a docassemble file opens as plain `yaml`, switch the language mode before debugging formatter behavior.
- The TextMate grammars remain the base syntax layer for YAML, Python, Mako, and Jinja regions.
- The language server is additive and does not replace the grammar-based highlighting.
- A status bar item shows whether the language server is running, missing, disabled, or failed to start.
- The extension now declares itself as the default formatter for `[docassemble]`, enables `editor.formatOnType`, and defaults docassemble indentation to 2 spaces with `editor.insertSpaces`; user settings can still override those values.

## Validation

- `npm test` runs the default extension-host smoke suite.
- `npm run test:real-lsp` runs a direct smoke test against the system `docassemble-lsp` command.
- `npm run test:real-lsp-extension` runs the opt-in extension-host real-server smoke path.
- The extension-host suite includes an Enter/on-type regression test that verifies the client sends `textDocument/onTypeFormatting` and applies the returned edit.

![yaml](https://raw.githubusercontent.com/jpagh/vscode-docassemble/main/demo.png)
