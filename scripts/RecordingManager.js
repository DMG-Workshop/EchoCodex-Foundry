import { newSessionId } from './ClipStore.js';

const MODULE_ID = 'echo-codex-notes';

/**
 * Captures session audio as a series of independently decodable clips.
 *
 * A four-hour session in one webm is roughly 40 MB, and the transcription
 * endpoint refuses anything over 25. Slicing a finished webm does not help —
 * only the first slice carries the container header. So the recorder rotates
 * instead: every few minutes the MediaRecorder is stopped and a new one started
 * on the same stream, producing a sequence of complete files, each one small
 * enough to upload and each tagged with its offset into the session so the
 * transcript stitches back onto a single clock.
 */
export class RecordingManager {
  constructor() {
    this.mediaRecorder = null;
    this.audioStream = null;
    // The original getUserMedia/getDisplayMedia streams, kept around only so
    // their tracks can be stopped on cleanup — when mixing ('both'), audioStream
    // itself is a synthetic AudioContext destination stream, not one of these.
    this.rawStreams = [];
    this.audioContext = null;
    this.clips = []; // { blob, offsetMs, index } — one per rotation, in session order
    this.clipIndex = 0;
    this.sessionId = null;
    // Called as each clip closes, so transcription can start during play
    // instead of queueing twenty uploads for the moment the game ends.
    this.onClipReady = null;
    this.isRecording = false;
    this.isPaused = false;
    this.startTime = null;
    this.pausedAt = null; // Timestamp of the current pause, if any
    this.totalPausedMs = 0; // Accumulated paused duration across the recording
    this.chunkMs = 0; // 0 disables rotation
    this.clipStartedAtMs = 0; // Active-recording ms when the current clip began
    this.rotationTimer = null;
    this.segments = []; // Track pause/resume segments
    this.sessionMetadata = emptyMetadata();
  }

  /** Resolves the recordingSource setting into a single MediaStream, mixing mic + system audio for 'both'. */
  async acquireAudioStream(source) {
    if (source === 'microphone') {
      const micStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
      this.rawStreams.push(micStream);
      return micStream;
    }

    if (source === 'system') {
      const displayStream = await navigator.mediaDevices.getDisplayMedia({ audio: true, video: false });
      this.rawStreams.push(displayStream);
      if (!displayStream.getAudioTracks().length) {
        this.showNotification('No system audio track was shared — check "share audio" in the browser prompt.', 'warning');
      }
      return displayStream;
    }

    // 'both': capture mic and system audio separately, then mix them into one
    // stream via Web Audio, since MediaRecorder only accepts a single stream.
    const [micStream, displayStream] = await Promise.all([
      navigator.mediaDevices.getUserMedia({ audio: true, video: false }),
      navigator.mediaDevices.getDisplayMedia({ audio: true, video: false })
    ]);
    this.rawStreams.push(micStream, displayStream);

    if (!displayStream.getAudioTracks().length) {
      this.showNotification('No system audio track was shared — recording microphone only.', 'warning');
    }

    this.audioContext = new AudioContext();
    const destination = this.audioContext.createMediaStreamDestination();

    for (const stream of [micStream, displayStream]) {
      if (!stream.getAudioTracks().length) continue;
      this.audioContext.createMediaStreamSource(stream).connect(destination);
    }

    return destination.stream;
  }

  async startRecording() {
    try {
      const source = game.settings.get(MODULE_ID, 'recordingSource');
      this.audioStream = await this.acquireAudioStream(source);

      // Collect metadata about the session
      this.sessionMetadata.campaignName = game.world.title;
      this.sessionMetadata.sceneName = canvas.scene?.name || 'Unknown Scene';
      this.sessionMetadata.gm = game.user.name;
      this.sessionMetadata.players = game.users
        .filter(u => !u.isGM && u.active)
        .map(u => u.name);
      this.sessionMetadata.startTime = new Date();

      this.clips = [];
      this.clipIndex = 0;
      this.sessionId = newSessionId();
      this.chunkMs = Number(game.settings.get(MODULE_ID, 'clipMinutes') || 0) * 60_000;
      this.isRecording = true;
      this.isPaused = false;
      this.startTime = Date.now();
      this.totalPausedMs = 0;
      this.pausedAt = null;
      this.clipStartedAtMs = 0;

      this.startClipRecorder();
      this.startRotationTimer();

      window.EchoCodexNotes.updateIndicator('recording');
      this.showNotification('Session recording started', 'info');

      return true;
    } catch (error) {
      console.error('Failed to start recording:', error);
      this.showNotification('Failed to start recording: ' + error.message, 'error');
      // A half-acquired capture still holds the mic and the tab-share banner.
      this.releaseStreams();
      if (this.audioContext) {
        await this.audioContext.close().catch(() => {});
        this.audioContext = null;
      }
      this.isRecording = false;
      window.EchoCodexNotes.updateIndicator('error');
      return false;
    }
  }

  /**
   * Starts a MediaRecorder for one clip. Each gets its own chunk array and its
   * own onstop, so a rotation in flight cannot append to the next clip.
   */
  startClipRecorder() {
    const mimeType = this.getSupportedMimeType();
    const recorder = new MediaRecorder(this.audioStream, mimeType ? { mimeType } : {});
    const chunks = [];
    const offsetMs = this.clipStartedAtMs;
    const index = this.clipIndex++;

    recorder.ondataavailable = (event) => {
      if (event.data.size > 0) chunks.push(event.data);
    };

    recorder.onerror = (event) => {
      console.error('Recording error:', event.error);
      this.showNotification('Recording error: ' + event.error, 'error');
      window.EchoCodexNotes.updateIndicator('error');
    };

    recorder.onstop = () => {
      const blob = new Blob(chunks, { type: recorder.mimeType || 'audio/webm' });
      if (blob.size > 0) {
        const clip = { blob, offsetMs, index };
        this.clips.push(clip);
        try {
          this.onClipReady?.(clip, this.sessionId);
        } catch (error) {
          // Handing the clip onward is a convenience; the clip itself is
          // already safe in `clips` and must not be lost to a listener fault.
          console.error(`${MODULE_ID} | Clip handler failed`, error);
        }
      }
      recorder.onStopped?.();
    };

    recorder.start(1000); // Collect data every second
    this.mediaRecorder = recorder;
  }

  startRotationTimer() {
    clearInterval(this.rotationTimer);
    if (!this.chunkMs) return;

    // Driven by elapsed *active* time rather than a plain interval, so a table
    // that pauses for a twenty-minute break does not rotate through it.
    this.rotationTimer = setInterval(() => {
      if (!this.isRecording || this.isPaused) return;
      const active = this.getRecordingDuration() ?? 0;
      if (active - this.clipStartedAtMs >= this.chunkMs) this.rotateClip();
    }, 1000);
  }

  /** Closes the current clip and opens the next one on the same stream. */
  rotateClip() {
    const previous = this.mediaRecorder;
    if (!previous || previous.state === 'inactive') return;

    this.clipStartedAtMs = this.getRecordingDuration() ?? this.clipStartedAtMs;
    previous.stop();
    this.startClipRecorder();
  }

  pauseRecording() {
    if (!this.isRecording || this.isPaused) return false;

    try {
      this.mediaRecorder.pause();
      this.isPaused = true;
      this.pausedAt = Date.now();

      // Record pause segment
      this.segments.push({
        type: 'pause',
        timestamp: this.pausedAt,
        duration: 0
      });

      window.EchoCodexNotes.updateIndicator('paused');
      this.showNotification('Recording paused', 'info');
      return true;
    } catch (error) {
      console.error('Failed to pause recording:', error);
      return false;
    }
  }

  resumeRecording() {
    if (!this.isRecording || !this.isPaused) return false;

    try {
      const pauseDuration = Date.now() - this.pausedAt;
      this.totalPausedMs += pauseDuration;
      this.pausedAt = null;

      // Update last pause segment with duration
      if (this.segments.length > 0 && this.segments[this.segments.length - 1].type === 'pause') {
        this.segments[this.segments.length - 1].duration = pauseDuration;
      }

      this.mediaRecorder.resume();
      this.isPaused = false;

      window.EchoCodexNotes.updateIndicator('recording');
      this.showNotification('Recording resumed', 'info');
      return true;
    } catch (error) {
      console.error('Failed to resume recording:', error);
      return false;
    }
  }

  async stopRecording() {
    if (!this.isRecording) return null;

    clearInterval(this.rotationTimer);
    this.rotationTimer = null;

    try {
      await this.closeCurrentClip();
    } catch (error) {
      console.error('Error stopping recording:', error);
    }

    const clips = [...this.clips].sort((a, b) => a.offsetMs - b.offsetMs);
    const sessionId = this.sessionId;
    const metadata = { ...this.sessionMetadata, endTime: new Date() };
    const segments = this.segments;

    this.isRecording = false;
    this.isPaused = false;
    this.releaseStreams();
    if (this.audioContext) {
      await this.audioContext.close().catch(() => {});
      this.audioContext = null;
    }
    this.clips = [];
    this.segments = [];
    this.mediaRecorder = null;
    this.sessionMetadata = emptyMetadata();

    if (!clips.length) {
      this.showNotification('The recording came back empty — nothing was captured.', 'warning');
      return null;
    }

    window.EchoCodexNotes.updateIndicator('processing');
    this.showNotification('Recording stopped. Processing...', 'info');

    return { clips, metadata, segments, sessionId };
  }

  /** Resolves once the active recorder's final blob has landed in `clips`. */
  closeCurrentClip() {
    const recorder = this.mediaRecorder;
    if (!recorder || recorder.state === 'inactive') return Promise.resolve();

    return new Promise((resolve) => {
      // A recorder that never fires onstop would hang the whole pipeline and
      // strand the audio; after two seconds take what has already landed.
      const timer = setTimeout(resolve, 2000);
      recorder.onStopped = () => {
        clearTimeout(timer);
        resolve();
      };
      recorder.stop();
    });
  }

  /** Stops every underlying track so the browser's recording indicators clear. */
  releaseStreams() {
    this.audioStream?.getTracks().forEach(track => track.stop());
    this.rawStreams.forEach(stream => stream.getTracks().forEach(track => track.stop()));
    this.rawStreams = [];
    this.audioStream = null;
  }

  getSupportedMimeType() {
    const types = [
      'audio/webm;codecs=opus',
      'audio/webm',
      'audio/ogg;codecs=opus',
      'audio/ogg',
      'audio/mp4'
    ];

    for (const type of types) {
      if (MediaRecorder.isTypeSupported(type)) {
        return type;
      }
    }

    return ''; // Browser will use default
  }

  showNotification(message, type = 'info') {
    if (type === 'error') ui.notifications.error(message);
    else if (type === 'warning') ui.notifications.warn(message);
    else ui.notifications.info(message);
  }

  getRecordingDuration() {
    if (!this.isRecording) return null;
    const ongoingPause = this.isPaused ? Date.now() - this.pausedAt : 0;
    return Date.now() - this.startTime - this.totalPausedMs - ongoingPause;
  }

  formatDuration(ms) {
    const seconds = Math.floor((ms / 1000) % 60);
    const minutes = Math.floor((ms / (1000 * 60)) % 60);
    const hours = Math.floor(ms / (1000 * 60 * 60));

    if (hours > 0) {
      return `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
    }
    return `${minutes}:${String(seconds).padStart(2, '0')}`;
  }
}

function emptyMetadata() {
  return {
    campaignName: null,
    sceneName: null,
    players: [],
    gm: null,
    startTime: null,
    endTime: null,
    segments: []
  };
}
