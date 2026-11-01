// Videoaufnahme: Der fertig entwickelte Sucher (Film-Look, Korn, Rahmen,
// Datum) wird als Canvas-Stream aufgenommen, dazu optional das Mikrofon.
// Safari auf dem iPhone liefert MP4 (H.264/AAC), Chrome WebM.

const TYPES = [
  'video/mp4;codecs=avc1.640028,mp4a.40.2',
  'video/mp4;codecs=avc1,mp4a.40.2',
  'video/mp4',
  'video/webm;codecs=vp9,opus',
  'video/webm;codecs=vp8,opus',
  'video/webm',
];

export function canRecordVideo() {
  return typeof MediaRecorder !== 'undefined' && typeof HTMLCanvasElement !== 'undefined' && !!HTMLCanvasElement.prototype.captureStream;
}

export function pickMimeType() {
  if (typeof MediaRecorder === 'undefined' || !MediaRecorder.isTypeSupported) return '';
  return TYPES.find((t) => MediaRecorder.isTypeSupported(t)) ?? '';
}

export function videoExtension(mime) {
  if (/mp4/.test(mime)) return '.mp4';
  if (/webm/.test(mime)) return '.webm';
  if (/quicktime/.test(mime)) return '.mov';
  return '.mp4';
}

export class VideoRecorder {
  constructor() {
    this.rec = null;
    this.chunks = [];
    this.mic = null;
    this.t0 = 0;
    this.micDenied = false;
  }

  get recording() {
    return !!this.rec && this.rec.state === 'recording';
  }

  get elapsed() {
    return this.rec ? (performance.now() - this.t0) / 1000 : 0;
  }

  async start(canvas, { fps = 30, audio = true, bitrate = 12_000_000 } = {}) {
    const stream = canvas.captureStream(fps);
    if (audio) {
      try {
        this.mic = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: true }, video: false });
        for (const t of this.mic.getAudioTracks()) stream.addTrack(t);
      } catch {
        this.micDenied = true;
      }
    }
    const mimeType = pickMimeType();
    this.rec = new MediaRecorder(stream, { ...(mimeType ? { mimeType } : {}), videoBitsPerSecond: bitrate, audioBitsPerSecond: 160_000 });
    this.mime = this.rec.mimeType || mimeType || 'video/mp4';
    this.stream = stream;
    this.chunks = [];
    this.rec.ondataavailable = (e) => {
      if (e.data && e.data.size) this.chunks.push(e.data);
    };
    this.rec.start(1000);
    this.t0 = performance.now();
  }

  stop() {
    return new Promise((resolve, reject) => {
      if (!this.rec) {
        reject(new Error('Keine Aufnahme aktiv'));
        return;
      }
      const rec = this.rec;
      const duration = this.elapsed;
      rec.onstop = () => {
        const blob = new Blob(this.chunks, { type: (this.mime || 'video/mp4').split(';')[0] });
        this.cleanup();
        resolve({ blob, duration, mime: blob.type });
      };
      rec.onerror = (e) => {
        this.cleanup();
        reject(e.error || new Error('Aufnahme fehlgeschlagen'));
      };
      try {
        rec.requestData?.();
      } catch {
        /* egal */
      }
      rec.stop();
    });
  }

  cleanup() {
    for (const t of this.stream?.getTracks() ?? []) t.stop();
    for (const t of this.mic?.getTracks() ?? []) t.stop();
    this.rec = null;
    this.mic = null;
    this.stream = null;
    this.chunks = [];
  }
}
