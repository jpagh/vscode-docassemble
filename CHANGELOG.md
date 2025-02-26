# Changelog

## 0.3.8 (2025-02-26)
Added Python highlighting to all blocks' `need: ` expression and list items.

## 0.3.7 (2025-02-26)
- Fixed an issue where Mako wasn't correctly applied in block-scalars (`|`), particularly on the first line (improves 0.3.5).

- Fixed `:` (colons) being incorrectly highlighted as a YAML key and breaking subsequent highlighting in `|` blocks.

- Removed `#` as a comment marker in Mako so that Markdown headers won't be "commented out" anymore.

- Cleaned up and expanded Python highlighting to more `code` blocks like `attachment code` and `verification code`.

- Updated YAML highlighting of values to be more Pythonic, so the only boolean values are "True" and "False" and the only null value is "None" (removed "true|TRUE", "false|FALSE", and "null|Null|NULL").

## 0.3.6 (2025-02-22)
Added syntax highlighting to `validation code` blocks.

## 0.3.5 (2025-02-22)
Fixed Mako and HTML highlighting on the first line of multiline YAML (`|`). Fixed some inconsistencies with the `.using()` method's highlighting.

## 0.3.4 (2025-02-19)
Added Python highlighting to all blocks' `if: ` expression and (imperfectly) to `objects` blocks' `using()` method.

## 0.3.3 (2025-02-18)
Updated the demo image to show more variety and updated this CHANGELOG since I missed it before.

## 0.3.2 (2025-02-18)
Fixed an issue with node modules being included in the extension package. Cleaned up a lot of other dependencies and garbage.

## 0.3.1 (2025-02-18)
- Improved syntax highlighting: Python `code` blocks now terminate on sub-keys (fixes 0.2.0's outstanding issue).

- HTML terminates more consistently overall.

- Mako expressions as keys in YAML key-pairs properly inherit the highlighting of the YAML key and retain otherwise proper Mako highlighting.

## 0.3.0 (2023-04-16)
Changed YAML highlighting of boolean values to match the interpretation of Docassemble. This removed all variations of "`Yes|No|On|Off`" from being highlighted as boolean values and leaves only "`true|True|TRUE|false|False|FALSE`".

## 0.2.0 (2023-02-27)
Missed some updates from version 0.0.1 through 0.0.7, and then accidentally updated version to 0.2.0, and then missed including the changelog to that version as well. So this is being backfilled.

This release was prompted by, and includes, a partial fix for `code` blocks not releasing python syntax highlighting back to yaml, particularly in `question`->`fields`. Sub-keys still aren't released properly (e.g., `default`), so the workaround is to make the `code` block the last thing in the key. Subsequent keys are now properly highlighted.

## 0.0.1 (2023-02-01)

### Features

* initial commit based on [Inline YAML Syntax Highlighting](https://github.com/monotykamary/inline-yaml)
