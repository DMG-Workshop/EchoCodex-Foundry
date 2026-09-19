import { RecordingManager } from './RecordingManager.js';
import { CurationUI, SOCKET } from './CurationUI.js';
import { flattenDocument } from './curationModel.js';
import { transcribe, structure } from './providers.js';
import { escapeHtml } from './html.js';
import { extensionFor } from './transcript.js';
import { collectVocabulary, parseTermList } from './vocabulary.js';

const MODULE_ID = 'echo-codex-notes';

class EchoCodexNotes {
  static recorder = new RecordingManager();
  static activeCuration = null;
  static durationInterval = null;

  static registerSettings() {
    const register = (key, data) => game.settings.register(MODULE_ID, key, data);

    register('importNote', {
      name: 'Import Echo Codex note',
      hint: 'Paste a JSON export from the Echo Codex app to import it as a Journal Entry.',
      scope: 'world',
      config: true,
      type: String,
      default: '',
      onChange: (value) => {
        if (value) importEchoCodexNote(value);
      }
    });

    register('recordingSource', {
      name: 'Recording source',
      hint: 'Where session audio is captured from. "Both" mixes your microphone with shared system audio.',
      scope: 'client',
      config: true,
      type: String,
      choices: {
        microphone: 'Microphone',
        system: 'System audio',
        both: 'Microphone and system audio'
      },
      default: 'microphone'
    });

    register('clipMinutes', {
      name: 'Clip length (minutes)',
      hint: 'Audio is recorded in clips of this length so no single upload exceeds the 25 MB transcription limit. '
        + 'Raise it only for a local endpoint without that limit; 0 records the whole session as one file.',
      scope: 'client',
      config: true,
      type: Number,
      range: { min: 0, max: 60, step: 5 },
      default: 10
    });

    // --- Stage 1: speech to text -------------------------------------
    register('sttProvider', {
      name: 'Transcription provider',
      hint: 'OpenAI-compatible covers api.openai.com and any local server that speaks the same API (whisper.cpp, LM Studio).',
      scope: 'client',
      config: true,
      type: String,
      choices: { openai: 'OpenAI-compatible', gemini: 'Gemini' },
      default: 'openai'
    });

    register('sttBaseUrl', {
      name: 'Transcription endpoint',
      hint: 'Base URL. Leave blank for the provider default; point it at your own machine to keep audio on the LAN.',
      scope: 'client',
      config: true,
      type: String,
      default: ''
    });

    // Keys are client-scoped on purpose: a world-scoped setting is synced to
    // every connected player, which would hand them the GM's API key.
    register('sttApiKey', {
      name: 'Transcription API key',
      hint: 'Stored in your browser only, never synced to players. Leave blank for a local server that needs no key.',
      scope: 'client',
      config: true,
      type: String,
      default: ''
    });

    register('sttModel', {
      name: 'Transcription model',
      scope: 'client',
      config: true,
      type: String,
      default: 'whisper-1'
    });

    register('sttLanguage', {
      name: 'Spoken language',
      hint: 'ISO-639-1 code for the language at your table, such as en, de or pt. '
        + 'Leave blank to detect it, which can vary clip to clip on a quiet recording.',
      scope: 'client',
      config: true,
      type: String,
      default: ''
    });

    // --- Stage 2: structuring ----------------------------------------
    register('structureProvider', {
      name: 'Structuring provider',
      hint: 'The model that turns the transcript into session notes.',
      scope: 'client',
      config: true,
      type: String,
      choices: {
        anthropic: 'Claude',
        openai: 'OpenAI-compatible (incl. Ollama, LM Studio)',
        gemini: 'Gemini'
      },
      default: 'anthropic'
    });

    register('structureBaseUrl', {
      name: 'Structuring endpoint',
      hint: 'Base URL. Leave blank for the provider default.',
      scope: 'client',
      config: true,
      type: String,
      default: ''
    });

    register('structureApiKey', {
      name: 'Structuring API key',
      hint: 'Stored in your browser only, never synced to players.',
      scope: 'client',
      config: true,
      type: String,
      default: ''
    });

    register('structureModel', {
      name: 'Structuring model',
      scope: 'client',
      config: true,
      type: String,
      default: 'claude-opus-5'
    });

    // --- Campaign vocabulary ------------------------------------------
    // World-scoped on purpose, unlike the API keys: this is campaign data the
    // whole table shares, and it should survive the GM switching machines.
    register('glossary', {
      name: 'Campaign glossary',
      hint: 'Names the transcriber keeps getting wrong — people, places, factions, items. '
        + 'Separate with commas or new lines. Character and NPC names from the Actors '
        + 'directory are included automatically; this is for everything else.',
      scope: 'world',
      config: true,
      type: String,
      default: ''
    });

    // --- Table workflow ----------------------------------------------
    register('enablePlayerVoting', {
      name: 'Enable player voting',
      hint: 'Let players mark session notes as worth keeping or dropping. The GM still decides.',
      scope: 'world',
      config: true,
      type: Boolean,
      default: true
    });

    register('separateGMNotes', {
      name: 'Separate GM notes',
      hint: 'Export a GM-only journal plus a player-facing handout, instead of one shared journal.',
      scope: 'world',
      config: true,
      type: Boolean,
      default: true
    });
  }

  static createIndicator() {
    const anchor = document.querySelector('#ui-left') ?? document.querySelector('#ui-top');
    if (!anchor || document.querySelector('#echo-codex-indicator')) return;

    const indicator = document.createElement('div');
    indicator.id = 'echo-codex-indicator';
    indicator.className = 'echo-codex-indicator';
    indicator.innerHTML = `
      <span class="status-dot"></span>
      <span class="status-text">Echo Codex</span>
    `;
    indicator.addEventListener('click', () => this.openCuration());
    anchor.prepend(indicator);
  }

  static updateIndicator(status) {
    const indicator = document.querySelector('#echo-codex-indicator');
    if (indicator) {
      const text = indicator.querySelector('.status-text');
      indicator.className = `echo-codex-indicator status-${status}`;
      if (text) text.textContent = {
        ready: 'Echo Codex',
        recording: 'Recording',
        paused: 'Paused',
        processing: 'Processing…',
        error: 'Error'
      }[status] ?? status;
    }

    clearInterval(this.durationInterval);
    this.durationInterval = null;
    if (status !== 'recording') return;

    this.durationInterval = setInterval(() => {
      const text = document.querySelector('#echo-codex-indicator .status-text');
      const ms = this.recorder.getRecordingDuration();
      if (text && ms != null) text.textContent = `Recording ${this.recorder.formatDuration(ms)}`;
    }, 1000);
  }

  /* --- Macro API ---------------------------------------------------- */

  static async startRecording() {
    if (!this.requireGM()) return;
    if (this.recorder.isRecording) {
      ui.notifications.warn('A recording is already running.');
      return;
    }
    await this.recorder.startRecording();
  }

  static pauseRecording() {
    if (this.requireGM()) this.recorder.pauseRecording();
  }

  static resumeRecording() {
    if (this.requireGM()) this.recorder.resumeRecording();
  }

  /** Stops capture, runs the two-stage pipeline, then opens curation. */
  static async stopRecordingAndProcess() {
    if (!this.requireGM()) return;

    const result = await this.recorder.stopRecording();
    if (!result) {
      this.updateIndicator('ready');
      return;
    }

    const notify = (message) => {
      this.updateIndicator('processing');
      ui.notifications.info(message);
    };

    try {
      const vocabulary = this.collectVocabulary();
      const segments = await transcribe(result.clips, { onProgress: notify, vocabulary });
      const transcriptText = segments.map(s => s.text).join(' ').trim();
      if (!transcriptText) throw new Error('The transcript came back empty.');

      const doc = await structure(segments, this.buildContext(result, vocabulary), { onProgress: notify });
      const rows = flattenDocument(doc);
      if (!rows.length) {
        ui.notifications.warn('Nothing structured out of this recording — the transcript may be too short.');
      }

      this.updateIndicator('ready');
      CurationUI.open({ doc, meta: result.metadata, rows });
    } catch (error) {
      console.error(`${MODULE_ID} | Processing failed`, error);
      ui.notifications.error(`Echo Codex: ${error.message}`);
      this.updateIndicator('error');
      // The recording is gone once we return, so hand it back rather than drop it.
      this.offerAudioDownload(result.clips);
    }
  }

  /**
   * A failed upload after a four-hour session must not lose the audio — save it
   * so the GM can retry, or transcribe it in the phone app instead.
   */
  static offerAudioDownload(clips) {
    if (!clips?.length) return;
    const stamp = Date.now();

    clips.forEach((clip, index) => {
      const url = URL.createObjectURL(clip.blob);
      const link = document.createElement('a');
      link.href = url;
      const part = clips.length > 1 ? `-part${String(index + 1).padStart(2, '0')}` : '';
      link.download = `echo-codex-session-${stamp}${part}.${extensionFor(clip.blob)}`;
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 30000);
    });

    ui.notifications.warn(
      clips.length > 1
        ? `The recording was saved to your downloads as ${clips.length} clips so it is not lost.`
        : 'The recording was saved to your downloads so it is not lost.'
    );
  }

  static openCuration() {
    if (game.user.isGM) {
      if (this.activeCuration) {
        this.activeCuration.render(true);
        this.activeCuration.bringToTop();
      } else {
        ui.notifications.info('No session notes yet. Record and process a session first.');
      }
      return;
    }
    CurationUI.openFollower();
  }

  /**
   * The campaign's proper nouns, from the GM's glossary and the world itself.
   *
   * Read at processing time rather than at record time so a name added while
   * the session was running still counts.
   */
  static collectVocabulary() {
    try {
      const actors = game.actors?.contents ?? [];
      const tokens = canvas?.scene?.tokens?.contents ?? [];

      return collectVocabulary({
        glossary: parseTermList(game.settings.get(MODULE_ID, 'glossary')),
        // The party is spoken about constantly, so it outranks the directory.
        playerCharacters: actors.filter(a => a.hasPlayerOwner).map(a => a.name),
        sceneActors: tokens.map(t => t.actor?.name ?? t.name),
        otherActors: actors.map(a => a.name)
      });
    } catch (error) {
      // Better notes are the point of this; they are not worth losing a
      // four-hour recording over.
      console.warn(`${MODULE_ID} | Could not assemble the campaign vocabulary`, error);
      return [];
    }
  }

  static buildContext(result, vocabulary = []) {
    const durationMs = new Date(result.metadata.endTime) - new Date(result.metadata.startTime);
    return {
      referenceDate: new Date(result.metadata.startTime).toISOString().slice(0, 10),
      timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      durationHuman: this.recorder.formatDuration(durationMs),
      sttProviderName: game.settings.get(MODULE_ID, 'sttProvider'),
      campaignName: result.metadata.campaignName,
      sceneName: result.metadata.sceneName,
      gm: result.metadata.gm,
      players: result.metadata.players,
      vocabulary
    };
  }

  static requireGM() {
    if (game.user.isGM) return true;
    ui.notifications.warn('Only the GM can control session recording.');
    return false;
  }
}

/* --- Existing JSON import path (unchanged behaviour) ----------------- */

async function importEchoCodexNote(raw) {
  try {
    const document = typeof raw === "string" ? JSON.parse(raw) : raw;
    const title = document.meta?.title ?? "Echo Codex session";
    const pages = [];

    pages.push({
      name: "Summary",
      type: "text",
      text: { format: 1, content: `<h1>${escapeHtml(title)}</h1><p>${escapeHtml(document.meta?.summary ?? "")}</p>` }
    });

    if (document.sections?.length) {
      pages.push({
        name: "Notes",
        type: "text",
        text: { format: 1, content: document.sections.map(section =>
          `<h2>${escapeHtml(section.heading)}</h2><ul>${(section.bullets ?? []).map(b => `<li>${escapeHtml(b)}</li>`).join("")}</ul>`
        ).join("") }
      });
    }

    if (document.decisions?.length || document.tasks?.length || document.openQuestions?.length) {
      pages.push({
        name: "Campaign actions",
        type: "text",
        text: { format: 1, content: [
          document.decisions?.length ? `<h2>Decisions</h2><ul>${document.decisions.map(d => `<li>${escapeHtml(d.statement)}</li>`).join("")}</ul>` : "",
          document.tasks?.length ? `<h2>Action items</h2><ul>${document.tasks.map(t => `<li>${escapeHtml(t.title)}${t.dueDate ? ` — due ${escapeHtml(t.dueDate)}` : ""}</li>`).join("")}</ul>` : "",
          document.openQuestions?.length ? `<h2>Open questions</h2><ul>${document.openQuestions.map(q => `<li>${escapeHtml(q.question)}</li>`).join("")}</ul>` : ""
        ].join("") }
      });
    }

    if (document.transcript) {
      pages.push({
        name: "Transcript",
        type: "text",
        text: { format: 1, content: `<pre>${escapeHtml(document.transcript)}</pre>` }
      });
    }

    await JournalEntry.create({ name: title, pages, flags: { [MODULE_ID]: { source: "Echo Codex" } } });
    ui.notifications.info(`Imported ${title} into a Journal Entry.`);
  } catch (error) {
    console.error(`${MODULE_ID} | Import failed`, error);
    ui.notifications.error("Echo Codex import failed. Check the JSON export format.");
  } finally {
    // A whole session export parked in a world setting is synced to every
    // client on every load; clear it once it has become a journal.
    if (game.user.isGM) await game.settings.set(MODULE_ID, "importNote", "");
  }
}

Hooks.once("init", () => {
  console.info(`${MODULE_ID} | Echo Codex Notes initialized`);
  EchoCodexNotes.registerSettings();
});

Hooks.once("ready", () => {
  EchoCodexNotes.createIndicator();
  EchoCodexNotes.updateIndicator('ready');
  // One listener for the lifetime of the client: curation outlives its window,
  // so answering players cannot depend on a dialog being open.
  game.socket.on(SOCKET, (payload) => CurationUI.handleSocket(payload));
});

window.EchoCodexNotes = EchoCodexNotes;
