# Changelog

All notable changes to this project will be documented in this file. See [standard-version](https://github.com/conventional-changelog/standard-version) for commit guidelines.

## 0.2.0 (2023-02-27)
Missed some updates from version 0.0.1 through 0.0.7, and then accidentally updated version to 0.2.0, and then missed including the changelog to that version as well. So this is being backfilled.

This release was prompted by, and includes, a partial fix for `code` blocks not releasing python syntax highlighting back to yaml, particularly in `question`->`fields`. Sub-keys still aren't released properly (e.g., `default`), so the workaround is to make the `code` block the last thing in the key. Subsequent keys are now properly highlighted.

## 0.0.1 (2023-02-01)

### Features

* initial commit based on [Inline YAML Syntax Highlighting](https://github.com/monotykamary/inline-yaml)
