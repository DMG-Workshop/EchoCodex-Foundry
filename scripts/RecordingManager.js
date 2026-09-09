export class RecordingManager {
  constructor() {
    this.mediaRecorder = null;
    this.audioStream = null;
    // The original getUserMedia/getDisplayMedia streams, kept around only so
    // their tracks can be stopped on cleanup — when mixing ('both'), audioStream
    // itself is a synthetic AudioContext destination stream, not one of these.
    this.rawStreams = [];
    this.audioContext = null;
    this.recordedChunks = [];
    this.isRecording = false;
    this.isPaused = false;
    this.startTime = null;
    this.pausedAt = null; // Timestamp of the current pause, if any
    this.totalPausedMs = 0; // Accumulated paused duration across the recording
    this.segments = []; // Track pause/resume segments
    this.sessionMetadata = {
      campaignName: null,
      sceneName: null,
      players: [],
      gm: null,
      startTime: null,
      endTime: null,
      segments: [] // { start, end, paused, duration }
    };
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
      const source = game.settings.get('echo-codex-notes', 'recordingSource');
      this.audioStream = await this.acquireAudioStream(source);

      // Collect metadata about the session
      this.sessionMetadata.campaignName = game.world.title;
      this.sessionMetadata.sceneName = canvas.scene?.name || 'Unknown Scene';
      this.sessionMetadata.gm = game.user.name;
      this.sessionMetadata.players = game.users
        .filter(u => !u.isGM && u.active)
        .map(u => u.name);
      this.sessionMetadata.startTime = new Date();

      // Setup media recorder
      const mimeType = this.getSupportedMimeType();
      this.mediaRecorder = new MediaRecorder(this.audioStream, { mimeType });

      this.mediaRecorder.ondataavailable = (event) => {
        if (event.data.size > 0) {
          this.recordedChunks.push(event.data);
        }
      };

      this.mediaRecorder.onerror = (event) => {
        console.error('Recording error:', event.error);
        this.showNotification('Recording error: ' + event.error, 'error');
        window.EchoCodexNotes.updateIndicator('error');
      };

      this.mediaRecorder.start(1000); // Collect data every second
      this.isRecording = true;
      this.isPaused = false;
      this.startTime = Date.now();
      this.totalPausedMs = 0;
      this.pausedAt = null;

      window.EchoCodexNotes.updateIndicator('recording');
      this.showNotification('Session recording started', 'info');

      return true;
    } catch (error) {
      console.error('Failed to start recording:', error);
      this.showNotification('Failed to start recording: ' + error.message, 'error');
      window.EchoCodexNotes.updateIndicator('error');
      return false;
    }
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

    return new Promise((resolve) => {
      this.mediaRecorder.onstop = async () => {
        try {
          const audioBlob = new Blob(this.recordedChunks, { type: this.mediaRecorder.mimeType || 'audio/webm' });
          const metadata = { ...this.sessionMetadata, endTime: new Date() };
          const segments = this.segments;
          this.isRecording = false;
          this.isPaused = false;

          // Stop every underlying track (mic + display, whether or not they
          // were mixed) so the browser's recording/sharing indicators clear.
          this.audioStream.getTracks().forEach(track => track.stop());
          this.rawStreams.forEach(stream => stream.getTracks().forEach(track => track.stop()));
          if (this.audioContext) {
            await this.audioContext.close();
            this.audioContext = null;
          }
          this.rawStreams = [];
          this.recordedChunks = [];
          this.segments = [];
          this.sessionMetadata = {
            campaignName: null,
            sceneName: null,
            players: [],
            gm: null,
            startTime: null,
            endTime: null,
            segments: []
          };

          window.EchoCodexNotes.updateIndicator('processing');
          this.showNotification('Recording stopped. Processing...', 'info');

          resolve({ audioBlob, metadata, segments });
        } catch (error) {
          console.error('Error stopping recording:', error);
          resolve(null);
        }
      };

      this.mediaRecorder.stop();
    });
  }

  getSupportedMimeType() {
    const types = [
      'audio/webm',
      'audio/webm;codecs=opus',
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
