# First-run shakedown

Everything in this module is covered by tests, and none of it has recorded a
real session. The gap is specific and worth naming: the test suite drives the
logic, while the browser and Foundry APIs — `MediaRecorder` rotation,
`getDisplayMedia`, IndexedDB, `ApplicationV2`, the GM↔player socket — are
exercised only against stubs. A green suite says the decisions are right; it
says nothing about whether the recording starts.

This is the list for finding that out deliberately, rather than discovering it
at the table with four hours of audio on the line.

## You do not need a four-hour session

The expensive thing to verify is clip rotation, and it is driven by elapsed
recording time, not wall-clock. Set **Clip length** to `1` and a three-minute
recording exercises the same code a four-hour one does: three clips, two
rotations, offsets stitched across them.

Do that first. Put the real settings back afterwards.

## Before you start

| Setting | For the shakedown |
|---|---|
| Clip length | `1` — three minutes then covers rotation |
| Transcribe during the session | On (the default) — this is the path to test |
| Transcription provider / key / model | Whatever you will actually use |
| Spoken language | Set it explicitly, e.g. `en` |
| Campaign glossary | Two or three names only you would know |
| Estimate cost before processing | On, so you see the figure before paying it |
| Ask players before recording | On, with at least one player connected |

Open the browser console (F12) and keep it open. Everything this module logs is
prefixed `echo-codex-notes |`, so filter on that.

## 1. It loads

- [ ] Module enables without an error in the console
- [ ] All settings appear under module settings
- [ ] An **Echo Codex** group appears in the scene controls
- [ ] `Ctrl+Shift+R`, `Ctrl+Shift+P`, `Ctrl+Shift+N` appear in Foundry's keybindings
- [ ] The sidebar indicator reads "Echo Codex"

**If the settings list is empty:** both `Hooks.once('init')` handlers did not
run. This is the failure the test stub was hiding at one point, so it is worth
an explicit look.

## 2. The table can see it (verify on a player client, not the GM's)

- [ ] A player gets the consent notice once, and not again on reload
- [ ] Declining warns the GM at next start and asks them to confirm
- [ ] **While recording, the player's indicator turns red and pulses**
- [ ] Pausing turns it amber on the player's client
- [ ] Stopping returns it to idle

The third item is the one that was broken before: the indicator existed on
player clients but the status was never transmitted. If it stays grey while the
GM is recording, the beacon is not arriving — check the socket in the console.

## 3. Capture starts

- [ ] `EchoCodexNotes.startRecording()` prompts for microphone permission
- [ ] With source "system" or "both", the browser share dialog offers audio
- [ ] "No system audio track was shared" appears if you forget to tick it
- [ ] The indicator goes red and the duration ticks up each second

## 4. Clip rotation — the headline unknown

With clip length at 1, record for three minutes.

- [ ] The indicator shows a progress counter (`· 1/2`) as clips complete
- [ ] At stop, the notifications name more than one clip
- [ ] Application → IndexedDB → `echo-codex-notes` → `clips` holds one row per clip
- [ ] Each row's `offsetMs` increases by roughly 60000

**If there is only one clip:** rotation never fired. Check `clipMinutes` read as
a number, and that the rotation interval is not being skipped by the paused
check.

**If a clip is 0 bytes:** the new `MediaRecorder` started before the stream was
ready — the rotation is too eager and needs the stop to settle first.

## 5. Streaming transcription

- [ ] Uploads begin *during* recording, not after (watch the Network tab)
- [ ] Only one upload is in flight at a time
- [ ] A clip's prompt carries the previous clip's tail (inspect a request body)
- [ ] The transcript reads continuously across a rotation boundary — no severed
      or invented words where one clip ends

That last one is the point of carrying the tail. Say a sentence deliberately
across a rotation and see whether it survives.

**To test failure handling:** put a wrong key in mid-session. Expect the clip to
retry once, then the queue to carry on, and the stop to warn which parts are
missing rather than failing the session.

## 6. Pause

- [ ] `pauseRecording()` / `resumeRecording()` work, and the indicator follows
- [ ] Pausing **Foundry itself** pauses the recording (Follow game pause is on)
- [ ] A two-minute pause does not burn through clips — rotation follows recording
      time, so the clip count should not jump

## 7. Stop and structure

- [ ] The cost estimate appears as a range before anything is charged
- [ ] Declining it leaves the recording intact rather than dropping it
- [ ] Structuring runs and curation opens
- [ ] The notes contain things that were actually said, and nothing that was not

**Read the notes adversarially.** The whole prompt is built against
fabrication — if a decision appears that the table never made, or an NPC nobody
mentioned, that is the most important bug this module can have and it will not
announce itself.

- [ ] Glossary names are spelled correctly in the notes
- [ ] A name you deliberately mumbled is either corrected or absent, not invented

## 8. Curation on ApplicationV2 — the other headline unknown

The window runs on `ApplicationV2` under v13 and the older `Application` under
v12. The chooser is tested; the frameworks are not.

- [ ] The window renders at all (a blank window means the template did not bind)
- [ ] Checkboxes, the GM toggle and inline edits all respond
- [ ] The filter box keeps focus while typing
- [ ] Merging two rows of the same kind works; two different kinds is refused
- [ ] Merging a GM-only row leaves the result GM-only
- [ ] **Undo** restores what a merge destroyed
- [ ] Reloading mid-curation offers the unexported list back

If events do not fire, `_onRender` is not binding — that is the V2-specific
failure and it looks like a window that renders but does nothing.

## 9. Player voting

- [ ] A player opening the notes receives the current list
- [ ] Their vote reaches the GM and the tally updates on both clients
- [ ] **A GM-only row is absent from the player's data, not merely hidden** —
      check in their console, not just their screen
- [ ] The GM closing the window does not stop players being answered

## 10. Export

- [ ] Two journals in an `Echo Codex — <campaign>` folder, with the GM copy
      holding everything
- [ ] The player handout is readable by players and omits GM-only rows
- [ ] Known names render as working `@UUID` links, and link to the right actor
- [ ] The transcript page is on the GM copy only
- [ ] A second session's notes mention continuity from the first

## 11. Recovery

- [ ] Refresh the browser mid-recording
- [ ] On reload the GM is told an unfinished recording is stored
- [ ] `EchoCodexNotes.processStoredSession('<id>')` turns it into notes
- [ ] Clips are gone from IndexedDB afterwards
- [ ] A *failed* run leaves them in place — they are the only copy

## 12. Second session

- [ ] Continuity from last week appears as background, and nothing from it
      leaks into this week's notes unless it happened again
- [ ] `EchoCodexNotes.buildCampaignIndex()` builds the rolling index
- [ ] Running it twice updates the journal rather than creating a second

## What to do with what you find

Anything here that fails is worth an issue with the console output and which
step it was, because every one of these paths is currently unverified rather
than known-good. The fabrication check in step 7 and the GM-only leak check in
step 9 are the two where a silent failure matters most — one puts invented
history into a campaign journal, the other shows players something they were
promised they would not see.
