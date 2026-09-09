# Echo Codex Notes for Foundry VTT

Standalone repository: https://github.com/DMG-Workshop/EchoCodex-Foundry

Two ways to get session notes into Foundry:

1. **Import** a JSON export from the Echo Codex app into a Journal Entry (the
   original path, unchanged).
2. **Record** the session in Foundry, transcribe and structure it with your own
   AI providers, curate the results with your players, and export to journals
   and handouts.

## How recording works

Echo Codex has no backend — the app runs entirely on your device against your
own AI providers. This module works the same way: the pipeline runs in your
browser, against endpoints you configure, and nothing passes through a server
we operate.

```
Recorder ──audio──▶ Speech-to-text ──text──▶ Structuring LLM ──JSON──▶ Curation ──▶ Journals
(Foundry)           (OpenAI-compatible       (Claude, or any          (GM + players)
                     or Gemini)               OpenAI-compatible
                                              incl. Ollama/LM Studio)
```

The structuring stage fills the same `NoteDocument` schema the app uses, so both
paths produce the same shape of notes. `scripts/noteDocumentSchema.js` is
generated from `docs/schemas/note-document.schema.json` in the main EchoCodex
repository — regenerate it rather than editing by hand.

### Keeping audio local

Both stages take a base URL. Point the transcription endpoint at a local
whisper.cpp server and the structuring endpoint at Ollama or LM Studio, and no
audio or transcript leaves your network.

## Curation

After processing, the GM gets a checklist of everything the model extracted —
narrative beats, decisions, action items, open questions, risks and dates —
each as its own row:

- **Uncheck** anything that wasn't really part of the session (rules arguments,
  snack runs, the tangent about someone's day job).
- **Edit** any row inline.
- **Merge** rows that say the same thing twice.
- **Mark GM-only** anything the players shouldn't see.
- Each row shows the verbatim transcript quote it came from, so you can tell a
  real beat from a mishearing.

Players can open the same list and vote Keep/Drop on each row. Votes are
advisory — they sync to the GM, who decides what actually ships. GM-only rows
are never sent to players' clients.

## Export

With **Separate GM notes** on (default), exporting creates two Journal Entries
in an `Echo Codex — <campaign>` folder: a GM-only entry with everything, and a
player-facing handout with the GM-only rows removed. Turn the setting off to
get a single journal visible to the whole table.

## Install

Copy this module into your Foundry `Data/modules/echo-codex-notes` directory and
enable **Echo Codex Notes** in the world.

## Configuration

All API keys are **client-scoped** — they live in the GM's browser and are never
synced to players. Configure per stage in module settings:

| Setting | Notes |
|---|---|
| Recording source | Microphone, system audio, or both mixed |
| Transcription provider / endpoint / key / model | OpenAI-compatible (default `whisper-1`) or Gemini |
| Structuring provider / endpoint / key / model | Claude (default `claude-opus-5`) or OpenAI-compatible |
| Enable player voting | Lets players vote on rows |
| Separate GM notes | GM journal + player handout, or one shared journal |

Calling a cloud AI provider straight from a browser means the key is present in
client-side code. That is acceptable for a GM running their own world on their
own machine; it is not a pattern to reuse for a public deployment. A local
endpoint avoids the question entirely.

## Macros

Create Script Macros with these one-liners:

| Macro | Script |
|---|---|
| Start recording | `EchoCodexNotes.startRecording()` |
| Pause | `EchoCodexNotes.pauseRecording()` |
| Resume | `EchoCodexNotes.resumeRecording()` |
| Stop and process | `EchoCodexNotes.stopRecordingAndProcess()` |
| View session notes (players) | `EchoCodexNotes.openCuration()` |

Clicking the Echo Codex indicator in the sidebar does the same as the last one.

## Status

The recording pipeline has not yet been exercised against a live Foundry world —
it is syntax-checked and written against the v13 API, but the first run should
be treated as a shakedown. Gemini is wired for transcription only; Gemini
structuring is not implemented yet.
