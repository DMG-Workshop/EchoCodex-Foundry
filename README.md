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
Recorder ──clips──▶ Speech-to-text ──text──▶ Structuring LLM ──JSON──▶ Curation ──▶ Journals
(Foundry)           (OpenAI-compatible       (Claude, Gemini, or      (GM + players)
                     or Gemini)               any OpenAI-compatible
                                              incl. Ollama/LM Studio)
```

### Clips, not one long file

Audio is captured in clips of a few minutes rather than one continuous file. A
four-hour session in a single webm is around 40 MB and the transcription
endpoint refuses anything over 25, and slicing a finished webm does not help —
only the first slice carries the container header. So the recorder rotates: it
closes each clip and opens the next on the same stream, giving a sequence of
complete files, each small enough to upload. Every clip records its offset into
the session, so the transcript stitches back onto one clock and a quote from
hour three still points at hour three.

Rotation follows recording time, not wall-clock time, so a twenty-minute break
does not burn through clips. Set **Clip length** to 0 to record one file instead
— worth doing only for a local endpoint with no upload limit.

The structuring stage fills the same `NoteDocument` schema the app uses, so both
paths produce the same shape of notes. `scripts/noteDocumentSchema.js` is
generated from `docs/schemas/note-document.schema.json` in the main EchoCodex
repository — regenerate it rather than editing by hand.

### Keeping audio local

Both stages take a base URL. Point the transcription endpoint at a local
whisper.cpp server and the structuring endpoint at Ollama or LM Studio, and no
audio or transcript leaves your network.

## Getting the names right

Transcription fails hardest on invented names, and a misheard one is not
cosmetic: "Ser Aldric" heard as "sir all drick" becomes a new character in the
campaign journal. Foundry already knows the real spellings, so the module uses
them at both stages.

Before transcribing, it assembles the campaign's proper nouns — the GM's
glossary first, then player characters, then actors on the current scene, then
the rest of the Actors directory — and sends them as Whisper's biasing prompt,
so recognition is steered *before* the error happens. The same list goes to the
structuring model, which corrects what still slipped through and records the
misheard form in the participant's aliases.

The list is ordered by how likely a name is to be spoken aloud, because both
stages are budget-limited and drop from the end. Whisper's prompt is capped at
224 tokens; a bestiary of 500 monsters will not crowd out the party.

Add anything the directory does not know — factions, places, items, the name of
the tavern — under **Campaign glossary** in the module settings. It is
world-scoped, so it follows the campaign rather than the GM's browser. Setting
**Spoken language** is worth it too: left blank, each clip is detected
independently, and a quiet clip can come back as the wrong language.

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
advisory — they sync to the GM, who decides what actually ships.

GM-only rows are removed from the socket payload before it is sent, not hidden
by the template: the message lands in every player's browser, where anything
merely hidden is one console command away.

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
| Clip length | Minutes per audio clip (default 10). 0 records one file |
| Transcription provider / endpoint / key / model | OpenAI-compatible (default `whisper-1`) or Gemini |
| Spoken language | ISO-639-1 code, or blank to detect per clip |
| Structuring provider / endpoint / key / model | Claude (default `claude-opus-5`), OpenAI-compatible, or Gemini |
| Campaign glossary | Names to feed both stages. World-scoped, not a secret |
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

## Development

```
npm test
```

No dependencies — the suite runs on Node's built-in test runner against the same
files Foundry loads. It covers the pure layers (curation model, transcript
stitching, schema conversion, journal HTML) and boots the real entry point
against a stubbed Foundry to catch import-time breakage. CI runs it on every
push.

### Cutting a release

Bump the version in `module.json` and `package.json`, then either:

- **push a tag** — `git tag -a v0.3.0 -m "…" && git push origin v0.3.0`, or
- **run it from the Actions tab** — *Release* → *Run workflow*, entering the
  version (`0.3.0`). The workflow creates the tag itself, which is the way in
  when tags cannot be pushed from where the release is being cut.

Either route runs the tests, refuses to publish if the version does not match
`module.json`, pins the manifest's `download` to the tag, and attaches
`echo-codex-notes.zip` and `module.json` to the release. A dispatch also refuses
a version whose tag already exists, rather than swapping the files under anyone
who installed it.

## Status

All three structuring providers are implemented, and the pipeline is covered by
tests end to end except for the two network calls themselves.

What has **not** happened yet is a run against a live Foundry world with real
audio and real provider keys. The browser-side pieces — `MediaRecorder`
rotation, `getDisplayMedia` audio capture, the socket round trip between GM and
players — are written against the v13 API and cannot be exercised by the test
suite. Treat the first session as a shakedown, and keep an eye on the clip count
in the notifications: it is the quickest sign that rotation is working.
