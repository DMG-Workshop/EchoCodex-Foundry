# Echo Codex Notes for Foundry VTT

Standalone repository: https://github.com/DMG-Workshop/EchoCodex-Foundry

This first module version imports an Echo Codex JSON export into a Foundry Journal Entry.
It creates pages for the summary, notes, campaign actions, and transcript when those fields
are present.

## Install during development

1. Copy this module into your Foundry `Data/modules/echo-codex-notes` directory.
2. Enable **Echo Codex Notes** in the world.
3. Open module settings and paste the JSON from Echo Codex's JSON export.

The module is intentionally file-based and has no hosted backend or network dependency.
The next integration step can add a file picker and direct task/actor document creation.
