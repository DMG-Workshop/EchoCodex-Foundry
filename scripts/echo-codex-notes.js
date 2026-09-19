import { RecordingManager } from './RecordingManager.js';
import { CurationUI, SOCKET } from './CurationUI.js';
import { flattenDocument } from './curationModel.js';
import { transcribe, transcribeClip, structure } from './providers.js';
import { TranscriptionQueue } from './TranscriptionQueue.js';
import { ClipStore, createIndexedDbBackend, createMemoryBackend } from './ClipStore.js';
import { WorldWitness } from './WorldWitness.js';
import { buildSessionLog } from './sessionLog.js';
import {
  findPreviousSession, summarizeForHistory, buildCampaignIndex, outstandingThreads
} from './campaignHistory.js';
import { estimateCost, estimateTranscriptionMinutes, describeEstimate } from './costEstimate.js';
import {
  BEACON, describeState, needsConsent, summarizeConsent, describeConsentGate
} from './recordingBeacon.js';
import { escapeHtml } from './html.js';
import { extensionFor } from './transcript.js';
import { collectVocabulary, parseTermList } from './vocabulary.js';

const MODULE_ID = 'echo-codex-notes';

class EchoCodexNotes {
  static recorder = new RecordingManager();
  static activeCuration = null;
  static durationInterval = null;
  static clipStore = null;
  static queue = null;
  static sessionVocabulary = [];
  static witness = new WorldWitness();

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

    register('followGamePause', {
      name: 'Pause recording with the game',
      hint: 'When the GM pauses Foundry, pause the recording too, and resume with it. '
        + 'Keeps breaks out of the transcript without anyone remembering to press anything.',
      scope: 'client',
      config: true,
      type: Boolean,
      default: true
    });

    register('showCostEstimate', {
      name: 'Estimate cost before processing',
      hint: 'Show a rough price range before sending a session to a paid provider. '
        + 'Estimates only — check your provider\'s current prices.',
      scope: 'client',
      config: true,
      type: Boolean,
      default: true
    });

    register('sttPricePerMinute', {
      name: 'Transcription price per minute',
      scope: 'client',
      config: true,
      type: Number,
      default: 0.006
    });

    register('structureInputPrice', {
      name: 'Structuring price per million input tokens',
      scope: 'client',
      config: true,
      type: Number,
      default: 5
    });

    register('structureOutputPrice', {
      name: 'Structuring price per million output tokens',
      scope: 'client',
      config: true,
      type: Number,
      default: 25
    });

    register('curationDraft', {
      name: 'Curation in progress',
      scope: 'world',
      config: false,
      type: Object,
      default: {}
    });

    register('requireConsent', {
      name: 'Ask players before recording',
      hint: 'Show each player a one-time notice that sessions may be recorded, and let them '
        + 'agree or object. The GM is warned before starting if anyone objected.',
      scope: 'world',
      config: true,
      type: Boolean,
      default: true
    });

    register('consentAnswers', {
      name: 'Consent answers',
      scope: 'world',
      config: false,
      type: Object,
      default: {}
    });

    register('retentionDays', {
      name: 'Keep recordings for (days)',
      hint: 'Stored audio from interrupted sessions is deleted after this many days. '
        + '0 keeps it until you delete it yourself. Audio is always deleted once it '
        + 'has successfully become notes.',
      scope: 'world',
      config: true,
      type: Number,
      range: { min: 0, max: 90, step: 1 },
      default: 14
    });

    register('useSessionLog', {
      name: 'Use the table\'s own records',
      hint: 'Fold typed chat, dice rolls, and scene and combat changes into the notes. '
        + 'These are literal where the transcript is a guess, so they correct misheard names '
        + 'and numbers. Whispers are never included.',
      scope: 'world',
      config: true,
      type: Boolean,
      default: true
    });

    register('useCampaignHistory', {
      name: 'Carry continuity between sessions',
      hint: 'Give the model the previous session\'s summary and loose threads, so names and '
        + 'storylines stay consistent week to week.',
      scope: 'world',
      config: true,
      type: Boolean,
      default: true
    });

    register('transcribeDuringSession', {
      name: 'Transcribe during the session',
      hint: 'Send each clip for transcription as it is recorded, instead of queueing every upload '
        + 'for the moment you stop. Notes arrive far sooner and a bad key shows up in minutes, '
        + 'not hours. Turn off to keep the table entirely offline until the game ends.',
      scope: 'client',
      config: true,
      type: Boolean,
      default: true
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

    register('handoutOwnership', {
      name: 'Player handout permission',
      hint: 'What players get on the exported handout. Observer lets them read it; '
        + 'Owner also lets them edit and add their own notes.',
      scope: 'world',
      config: true,
      type: String,
      choices: { observer: 'Can read', owner: 'Can read and edit' },
      default: 'observer'
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
      <span class="status-detail"></span>
    `;
    indicator.addEventListener('click', () => this.openCuration());
    anchor.prepend(indicator);
  }

  /** Players are told what the recorder is doing; they cannot see it otherwise. */
  static broadcastRecordingState(status) {
    if (!game.user.isGM) return;
    game.socket.emit(SOCKET, {
      type: BEACON,
      status,
      startedAt: this.recorder.startTime ?? null
    });
  }

  static applyRecordingState(payload) {
    const state = describeState({ status: payload.status, startedAt: payload.startedAt });
    const indicator = document.querySelector('#echo-codex-indicator');
    if (!indicator) return;
    indicator.className = `echo-codex-indicator status-${state.className}`;
    indicator.title = state.label;
    const text = indicator.querySelector('.status-text');
    if (text) text.textContent = state.recording ? state.label : 'Echo Codex';
  }

  static updateIndicator(status) {
    this.broadcastRecordingState(status);
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

    if (status === 'ready' || status === 'error') {
      const detail = document.querySelector('#echo-codex-indicator .status-detail');
      if (detail) detail.textContent = '';
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

    if (!await this.confirmConsent()) return;

    // Read once, at the top: the vocabulary has to be ready before the first
    // clip closes, because that clip is transcribed while the game is running.
    this.sessionVocabulary = this.collectVocabulary();
    this.queue = this.createQueue();

    const live = game.settings.get(MODULE_ID, 'transcribeDuringSession');
    this.recorder.onClipReady = (clip, sessionId) => {
      this.persistClip(sessionId, clip);
      if (live) this.queue.enqueue(clip);
    };

    if (game.settings.get(MODULE_ID, 'useSessionLog')) this.witness.start();

    const started = await this.recorder.startRecording();
    if (!started) this.witness.stop();
  }

  /**
   * Warns the GM about anyone who objected, and lets them decide.
   *
   * Deliberately not enforced by muting: this module cannot separate one voice
   * from a shared room, so silently "excluding" someone would be a false
   * promise. What it can do is make the objection impossible to miss.
   */
  static async confirmConsent() {
    if (!game.settings.get(MODULE_ID, 'requireConsent')) return true;

    const summary = summarizeConsent(
      game.users.filter(u => !u.isGM && u.active).map(u => ({ id: u.id, name: u.name })),
      game.settings.get(MODULE_ID, 'consentAnswers') ?? {}
    );
    const gate = describeConsentGate(summary);
    if (!gate.message) return true;

    if (!gate.blocking) {
      ui.notifications.warn(`Echo Codex: ${gate.message}`);
      return true;
    }

    return Dialog.confirm({
      title: 'Someone objected to being recorded',
      content: `<p>${escapeHtml(gate.message)}</p><p>Start recording anyway?</p>`,
      defaultYes: false
    });
  }

  /** Asks this player once, and remembers the answer against their user. */
  static async promptForConsent() {
    if (game.user.isGM) return;
    const answers = game.settings.get(MODULE_ID, 'consentAnswers') ?? {};
    const required = game.settings.get(MODULE_ID, 'requireConsent');

    if (!needsConsent({
      consentRequired: required,
      recorded: true,
      alreadyAnswered: answers[game.user.id] != null
    })) return;

    const agreed = await Dialog.confirm({
      title: 'This table records its sessions',
      content: '<p>The GM may record audio of this game to generate session notes. '
        + 'Audio is processed through the AI services the GM has configured, and is deleted '
        + 'once it has become notes.</p><p>Are you comfortable being recorded?</p>',
      defaultYes: true
    });

    // Players cannot write world settings, so the GM records the answer.
    game.socket.emit(SOCKET, {
      type: 'consent',
      userId: game.user.id,
      answer: agreed ? 'agreed' : 'declined'
    });
  }

  static async recordConsent(userId, answer) {
    if (!game.user.isGM) return;
    const answers = { ...(game.settings.get(MODULE_ID, 'consentAnswers') ?? {}) };
    answers[userId] = answer;
    await game.settings.set(MODULE_ID, 'consentAnswers', answers);

    if (answer === 'declined') {
      const user = game.users.get(userId);
      ui.notifications.warn(`Echo Codex: ${user?.name ?? 'A player'} declined to be recorded.`);
    }
  }

  static createQueue() {
    return new TranscriptionQueue({
      transcribeClip: (clip, { previousTail }) =>
        transcribeClip(clip, { vocabulary: this.sessionVocabulary, previousTail }),
      onProgress: (state) => this.updateTranscriptionProgress(state),
      onError: (error, clip) =>
        console.warn(`${MODULE_ID} | Clip ${(clip.index ?? 0) + 1} failed to transcribe`, error)
    });
  }

  /**
   * Shows transcription catching up behind the recording, so a GM can tell at a
   * glance whether stopping now means a wait.
   */
  static updateTranscriptionProgress(state) {
    const indicator = document.querySelector('#echo-codex-indicator .status-detail');
    if (!indicator) return;
    indicator.textContent = state.pending
      ? ` · ${state.completed}/${state.enqueued}`
      : '';
  }

  static getClipStore() {
    if (!this.clipStore) {
      const backend = createIndexedDbBackend() ?? createMemoryBackend();
      this.clipStore = new ClipStore(backend);
    }
    return this.clipStore;
  }

  static async persistClip(sessionId, clip) {
    try {
      await this.getClipStore().put(sessionId, clip);
    } catch (error) {
      // Storage being full or blocked is not a reason to stop recording; the
      // clip is still in memory for this session.
      console.warn(`${MODULE_ID} | Could not store clip ${clip.index}`, error);
    }
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

    this.witness.stop();

    const result = await this.recorder.stopRecording();
    if (!result) {
      this.updateIndicator('ready');
      return;
    }

    // Written now rather than at start: only at stop is the session's own shape
    // known, and it is what names the recording if recovery is ever needed.
    await this.getClipStore()
      .attachMetadata(result.sessionId, result.metadata)
      .catch(() => {});

    const notify = (message) => {
      this.updateIndicator('processing');
      ui.notifications.info(message);
    };

    try {
      const vocabulary = this.sessionVocabulary.length
        ? this.sessionVocabulary
        : this.collectVocabulary();

      const segments = await this.transcribeSession(result, { notify, vocabulary });
      const transcriptText = segments.map(s => s.text).join(' ').trim();
      if (!transcriptText) throw new Error('The transcript came back empty.');

      const gaps = this.queue?.describeGaps();
      if (gaps) ui.notifications.warn(`Echo Codex: ${gaps}`);

      if (!await this.confirmCost(result.clips, transcriptText)) {
        this.updateIndicator('ready');
        return;
      }

      const doc = await structure(segments, this.buildContext(result, vocabulary), { onProgress: notify });
      // Kept so the GM copy can carry the unedited room alongside the notes.
      doc.transcript = segments
        .map(s => (s.startMs == null ? s.text : `[${this.recorder.formatDuration(s.startMs)}] ${s.text}`))
        .join('\n');
      const rows = flattenDocument(doc);
      if (!rows.length) {
        ui.notifications.warn('Nothing structured out of this recording — the transcript may be too short.');
      }

      this.updateIndicator('ready');
      // The audio has become notes; keeping it would only accumulate.
      await this.getClipStore().deleteSession(result.sessionId).catch(() => {});
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
   * Finishes the transcript, using whatever the live queue already did.
   *
   * With streaming on, most clips are transcribed before the session ends and
   * only the last one is outstanding; with it off, the queue is empty and this
   * is the original all-at-once path.
   */
  static async transcribeSession(result, { notify, vocabulary }) {
    const queue = this.queue;
    if (!queue || !queue.enqueued) {
      return transcribe(result.clips, { onProgress: notify, vocabulary });
    }

    // Clips are enqueued in order as they close, so anything at or past the
    // enqueued count is new — in practice the final clip, which only closes at
    // stop and so was never handed over during play.
    for (const clip of result.clips) {
      if (clip.index >= queue.enqueued) queue.enqueue(clip);
    }

    if (queue.state.pending) {
      notify(`Finishing transcription (${queue.state.completed}/${queue.state.enqueued})…`);
    }
    return queue.drain();
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

  /**
   * Recovers a session that was interrupted before it became notes.
   *
   * A refresh mid-game, a crashed tab, a failed upload run — the clips are on
   * disk either way, and without a way back in they were only ever a folder of
   * webm files nobody could use.
   */
  static async recoverSessions() {
    if (!this.requireGM()) return [];
    try {
      return await this.getClipStore().listSessions();
    } catch (error) {
      console.error(`${MODULE_ID} | Could not read stored recordings`, error);
      ui.notifications.error('Echo Codex: stored recordings could not be read.');
      return [];
    }
  }

  /** Runs the pipeline over a stored session, as if it had just been recorded. */
  static async processStoredSession(sessionId) {
    if (!this.requireGM()) return;

    const store = this.getClipStore();
    const [clips, sessions] = await Promise.all([
      store.listSession(sessionId),
      store.listSessions()
    ]);
    if (!clips.length) {
      ui.notifications.warn('Echo Codex: no clips are stored for that session.');
      return;
    }

    const stored = sessions.find(s => s.sessionId === sessionId);
    const metadata = stored?.metadata ?? {
      campaignName: game.world.title,
      sceneName: canvas?.scene?.name ?? 'Recovered session',
      players: [],
      gm: game.user.name,
      startTime: new Date(stored?.storedAt ?? Date.now()),
      endTime: new Date(stored?.storedAt ?? Date.now())
    };

    const notify = (message) => {
      this.updateIndicator('processing');
      ui.notifications.info(message);
    };

    try {
      const vocabulary = this.collectVocabulary();
      // A fresh queue: this run has no live progress behind it.
      this.queue = this.createQueue();
      for (const clip of clips) this.queue.enqueue(clip);
      const segments = await this.queue.drain();

      const transcriptText = segments.map(s => s.text).join(' ').trim();
      if (!transcriptText) throw new Error('The transcript came back empty.');

      const gaps = this.queue.describeGaps();
      if (gaps) ui.notifications.warn(`Echo Codex: ${gaps}`);

      const doc = await structure(segments, this.buildContext({ metadata }, vocabulary), { onProgress: notify });
      this.updateIndicator('ready');
      await store.deleteSession(sessionId).catch(() => {});
      CurationUI.open({ doc, meta: metadata, rows: flattenDocument(doc) });
    } catch (error) {
      console.error(`${MODULE_ID} | Recovery failed`, error);
      ui.notifications.error(`Echo Codex: ${error.message}`);
      this.updateIndicator('error');
      // Deliberately not deleted: the clips are the only copy left.
    }
  }

  /** Tells the GM, once per load, that an interrupted session is still recoverable. */
  static async announceRecoverableSessions() {
    const sessions = await this.recoverSessions();
    if (!sessions.length) return;

    const [newest] = sessions;
    ui.notifications.warn(
      `Echo Codex: an unfinished recording is stored (${newest.clipCount} clips, `
      + `~${Math.round(newest.bytes / 1048576)} MB). `
      + `Run EchoCodexNotes.processStoredSession('${newest.sessionId}') to turn it into notes, `
      + `or EchoCodexNotes.discardStoredSession('${newest.sessionId}') to delete it.`
    );
  }

  /** Honours the retention window; audio nobody turned into notes does not linger forever. */
  static async pruneStoredAudio() {
    const days = Number(game.settings.get(MODULE_ID, 'retentionDays') || 0);
    if (!days) return;
    try {
      const dropped = await this.getClipStore().prune({ maxAgeMs: days * 86_400_000 });
      if (dropped.length) {
        ui.notifications.info(
          `Echo Codex: deleted ${dropped.length} stored recording(s) older than ${days} days.`
        );
      }
    } catch (error) {
      console.warn(`${MODULE_ID} | Retention sweep failed`, error);
    }
  }

  static async discardStoredSession(sessionId) {
    if (!this.requireGM()) return;
    const removed = await this.getClipStore().deleteSession(sessionId);
    ui.notifications.info(`Echo Codex: discarded ${removed} stored clips.`);
  }

  /** Picks curation back up where a closed tab left it. */
  static async restoreCurationDraft() {
    try {
      const draft = game.settings.get(MODULE_ID, 'curationDraft');
      if (!draft?.rows?.length) return;
      await CurationUI.restoreDraft();
      ui.notifications.info('Echo Codex: restored session notes you had not exported yet.');
    } catch (error) {
      console.warn(`${MODULE_ID} | Could not restore curation`, error);
    }
  }

  /** Shows what a paid run will cost before it runs. */
  static async confirmCost(clips, transcriptText) {
    if (!game.settings.get(MODULE_ID, 'showCostEstimate')) return true;

    const sttPerMinute = Number(game.settings.get(MODULE_ID, 'sttPricePerMinute') || 0);
    const inputPerMTok = Number(game.settings.get(MODULE_ID, 'structureInputPrice') || 0);
    const outputPerMTok = Number(game.settings.get(MODULE_ID, 'structureOutputPrice') || 0);
    // A local endpoint costs nothing; there is nothing to warn about.
    if (!sttPerMinute && !inputPerMTok && !outputPerMTok) return true;

    const estimate = estimateCost({
      transcriptChars: transcriptText.length,
      minutes: estimateTranscriptionMinutes(clips, Number(game.settings.get(MODULE_ID, 'clipMinutes') || 10)),
      sttPerMinute, inputPerMTok, outputPerMTok
    });
    const description = describeEstimate(estimate);
    if (!description) return true;

    return Dialog.confirm({
      title: 'Structure these notes?',
      content: `<p>${escapeHtml(description)}</p>`,
      defaultYes: true
    });
  }

  /** Builds the rolling "campaign so far" journal from what exports already recorded. */
  static async buildCampaignIndex() {
    if (!this.requireGM()) return null;

    const index = buildCampaignIndex(game.journal?.contents ?? []);
    if (!index.length) {
      ui.notifications.info('Echo Codex: no recorded sessions yet.');
      return null;
    }

    const threads = outstandingThreads(index);
    const body = [
      `<h2>Sessions</h2><ol>${index.map(s =>
        `<li><strong>${escapeHtml(s.title)}</strong> — ${escapeHtml(s.summary)}</li>`
      ).join('')}</ol>`,
      threads.length
        ? `<h2>Still open</h2><ul>${threads.map(t =>
            `<li>${escapeHtml(t.question)} <em>(since ${escapeHtml(t.from)})</em></li>`
          ).join('')}</ul>`
        : ''
    ].filter(Boolean).join('\n');

    const name = `Echo Codex — ${game.world.title} so far`;
    const existing = game.journal.find(j => j.name === name);
    if (existing) {
      const [page] = existing.pages.contents;
      if (page) await page.update({ 'text.content': body });
      else await existing.createEmbeddedDocuments('JournalEntryPage', [{ name: 'Campaign', type: 'text', text: { format: CONST.JOURNAL_ENTRY_PAGE_FORMATS.HTML, content: body } }]);
      ui.notifications.info('Echo Codex: campaign index updated.');
      return existing;
    }

    const journal = await JournalEntry.create({ name, flags: { [MODULE_ID]: { source: 'Echo Codex', index: true } } });
    await journal.createEmbeddedDocuments('JournalEntryPage', [
      { name: 'Campaign', type: 'text', text: { format: CONST.JOURNAL_ENTRY_PAGE_FORMATS.HTML, content: body } }
    ]);
    ui.notifications.info('Echo Codex: campaign index created.');
    return journal;
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
    const durationMs = Math.max(
      0,
      new Date(result.metadata.endTime) - new Date(result.metadata.startTime)
    ) || 0;
    return {
      referenceDate: new Date(result.metadata.startTime).toISOString().slice(0, 10),
      timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      durationHuman: this.recorder.formatDuration(durationMs),
      sttProviderName: game.settings.get(MODULE_ID, 'sttProvider'),
      campaignName: result.metadata.campaignName,
      sceneName: result.metadata.sceneName,
      gm: result.metadata.gm,
      players: result.metadata.players,
      vocabulary,
      sessionLog: this.collectSessionLog(result.metadata),
      previousSession: this.findPreviousSession()
    };
  }

  /** The world's own record of the session, on the transcript's clock. */
  static collectSessionLog(metadata) {
    if (!game.settings.get(MODULE_ID, 'useSessionLog')) return [];
    try {
      return buildSessionLog(
        { messages: WorldWitness.readChatLog(), events: this.witness.events },
        { startedAt: metadata.startTime, endedAt: metadata.endTime }
      );
    } catch (error) {
      console.warn(`${MODULE_ID} | Could not assemble the session log`, error);
      return [];
    }
  }

  static findPreviousSession() {
    if (!game.settings.get(MODULE_ID, 'useCampaignHistory')) return null;
    try {
      return findPreviousSession(game.journal?.contents ?? []);
    } catch (error) {
      console.warn(`${MODULE_ID} | Could not read the previous session`, error);
      return null;
    }
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

  // Breaks are not session content; following the game's own pause keeps them
  // out without anyone having to remember a macro.
  Hooks.on('pauseGame', (paused) => {
    if (!game.user.isGM) return;
    if (!game.settings.get(MODULE_ID, 'followGamePause')) return;
    if (!EchoCodexNotes.recorder.isRecording) return;
    if (paused) EchoCodexNotes.recorder.pauseRecording();
    else EchoCodexNotes.recorder.resumeRecording();
  });

  if (game.user.isGM) {
    EchoCodexNotes.pruneStoredAudio();
    EchoCodexNotes.announceRecoverableSessions();
    EchoCodexNotes.restoreCurationDraft();
  } else {
    EchoCodexNotes.promptForConsent();
  }
});

window.EchoCodexNotes = EchoCodexNotes;
