import { RecordingManager } from './RecordingManager.js';
import { CurationUI } from './CurationUI.js';
import { flattenDocument } from './curationModel.js';
import { transcribe, structure } from './providers.js';

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

    // --- Stage 2: structuring ----------------------------------------
    register('structureProvider', {
      name: 'Structuring provider',
      hint: 'The model that turns the transcript into session notes.',
      scope: 'client',
      config: true,
      type: String,
      choices: { anthropic: 'Claude', openai: 'OpenAI-compatible (incl. Ollama, LM Studio)' },
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
      text.textContent = {
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
      const segments = await transcribe(result.audioBlob, { onProgress: notify });
      const transcriptText = segments.map(s => s.text).join(' ').trim();
      if (!transcriptText) throw new Error('The transcript came back empty.');

      const doc = await structure(segments, this.buildContext(result), { onProgress: notify });
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
      this.offerAudioDownload(result.audioBlob);
    }
  }

  /**
   * A failed upload after a four-hour session must not lose the audio — save it
   * so the GM can retry, or transcribe it in the phone app instead.
   */
  static offerAudioDownload(audioBlob) {
    const url = URL.createObjectURL(audioBlob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `echo-codex-session-${Date.now()}.webm`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
    ui.notifications.warn('The recording was saved to your downloads so it is not lost.');
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

  static buildContext(result) {
    const durationMs = new Date(result.metadata.endTime) - new Date(result.metadata.startTime);
    return {
      referenceDate: new Date(result.metadata.startTime).toISOString().slice(0, 10),
      timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      durationHuman: this.recorder.formatDuration(durationMs),
      sttProviderName: game.settings.get(MODULE_ID, 'sttProvider'),
      campaignName: result.metadata.campaignName,
      sceneName: result.metadata.sceneName,
      gm: result.metadata.gm,
      players: result.metadata.players
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
  }
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

Hooks.once("init", () => {
  console.info(`${MODULE_ID} | Echo Codex Notes initialized`);
  EchoCodexNotes.registerSettings();
});

Hooks.once("ready", () => {
  EchoCodexNotes.createIndicator();
  EchoCodexNotes.updateIndicator('ready');
});

window.EchoCodexNotes = EchoCodexNotes;
