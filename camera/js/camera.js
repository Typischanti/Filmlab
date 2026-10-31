// Kamerazugriff: Stream, Objektive, Lage des Telefons, Bildaufnahme.

import { deviceRotation } from './model.js';

const RES = {
  high: { width: { ideal: 4032 }, height: { ideal: 3024 } },
  fast: { width: { ideal: 1920 }, height: { ideal: 1440 } },
};

// Objektive anhand der Gerätebezeichnung einordnen (Deutsch und Englisch).
function classify(label) {
  const l = label.toLowerCase();
  if (/front|vorder|facetime|true ?depth/.test(l)) return 'front';
  if (/dual|triple/.test(l)) return null; // virtuelle Kameras überspringen
  if (/ultra/.test(l)) return 0.5;
  if (/tele/.test(l)) return 3;
  if (/back|rück|rear|kamera|camera/.test(l)) return 1;
  return null;
}

export class Camera {
  constructor(video) {
    this.video = video;
    this.stream = null;
    this.facing = 'environment';
    this.lens = 1;
    this.lenses = []; // [{ zoom, deviceId, digital? }]
    this.frontId = null;
    this.quality = 'high';
    this.deviceRot = 0;
    this.motionOn = false;
    this.onLensesChanged = null;
    this.onRotation = null;
  }

  get mirrored() {
    return this.facing === 'user';
  }

  get width() {
    return this.video.videoWidth;
  }

  get height() {
    return this.video.videoHeight;
  }

  async start() {
    this.stop();
    const video = { ...RES[this.quality], frameRate: { ideal: 30 } };
    if (this.facing === 'user') {
      if (this.frontId) video.deviceId = { exact: this.frontId };
      else video.facingMode = 'user';
    } else {
      const l = this.lenses.find((x) => x.zoom === this.lens && !x.digital) ?? this.lenses.find((x) => x.zoom === 1 && !x.digital);
      if (l) video.deviceId = { exact: l.deviceId };
      else video.facingMode = { ideal: 'environment' };
    }
    this.stream = await navigator.mediaDevices.getUserMedia({ video, audio: false });
    this.video.srcObject = this.stream;
    this.video.muted = true;
    this.video.setAttribute('playsinline', '');
    await this.video.play().catch(() => {});
    await new Promise((res) => {
      if (this.video.videoWidth) res();
      else this.video.addEventListener('loadedmetadata', res, { once: true });
    });
    if (!this.lenses.length) await this.discover();
    await this.applyDigitalZoom();
  }

  stop() {
    if (this.stream) for (const t of this.stream.getTracks()) t.stop();
    this.stream = null;
    this.video.srcObject = null;
  }

  get track() {
    return this.stream?.getVideoTracks()[0] ?? null;
  }

  // Nach der ersten Freigabe stehen die Gerätenamen zur Verfügung.
  async discover() {
    const devs = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'videoinput');
    const lenses = [];
    for (const d of devs) {
      const c = classify(d.label || '');
      if (c === 'front') this.frontId ??= d.deviceId;
      else if (typeof c === 'number' && !lenses.some((x) => x.zoom === c)) lenses.push({ zoom: c, deviceId: d.deviceId });
    }
    // Ohne erkennbare Namen: aktuelles Gerät als 1×
    if (!lenses.length) {
      const id = this.track?.getSettings?.().deviceId;
      if (id) lenses.push({ zoom: 1, deviceId: id });
    }
    // 2× als Ausschnitt des Hauptsensors, wenn die Kamera Zoom unterstützt
    const main = lenses.find((x) => x.zoom === 1);
    const caps = this.track?.getCapabilities?.() ?? {};
    if (main && caps.zoom && caps.zoom.max >= 2 && this.facing === 'environment' && this.lens === 1) {
      lenses.push({ zoom: 2, deviceId: main.deviceId, digital: true });
    }
    lenses.sort((a, b) => a.zoom - b.zoom);
    this.lenses = lenses;
    this.onLensesChanged?.(lenses);
  }

  async applyDigitalZoom() {
    const t = this.track;
    const caps = t?.getCapabilities?.() ?? {};
    if (!caps.zoom) return;
    const want = this.facing === 'environment' && this.lens === 2 ? 2 : 1;
    try {
      await t.applyConstraints({ advanced: [{ zoom: Math.max(caps.zoom.min ?? 1, want) }] });
    } catch {
      /* nicht unterstützt */
    }
  }

  async setLens(zoom) {
    const prev = this.lenses.find((x) => x.zoom === this.lens);
    const next = this.lenses.find((x) => x.zoom === zoom);
    if (!next) return;
    this.lens = zoom;
    // 1× <-> 2× wechselt nur den Zoom, nicht das Gerät
    if (prev && prev.deviceId === next.deviceId && this.stream) await this.applyDigitalZoom();
    else await this.start();
  }

  async flip() {
    this.facing = this.facing === 'user' ? 'environment' : 'user';
    await this.start();
  }

  // Lagesensor: iOS verlangt eine Erlaubnis, die nur bei einer Berührung
  // erfragt werden darf.
  async enableMotion() {
    if (this.motionOn) return true;
    try {
      if (typeof DeviceMotionEvent !== 'undefined' && typeof DeviceMotionEvent.requestPermission === 'function') {
        const r = await DeviceMotionEvent.requestPermission();
        if (r !== 'granted') return false;
      }
    } catch {
      return false;
    }
    this.motionOn = true;
    let calibrated = false;
    let flipSign = 1;
    window.addEventListener('devicemotion', (e) => {
      const g = e.accelerationIncludingGravity;
      if (!g || g.x == null) return;
      // Browser ohne iOS-Vorzeichen erkennen: aufrecht gehalten zeigt y dann
      // nach oben (positiv). Einmalig beim ersten deutlichen Messwert.
      if (!calibrated && Math.abs(g.y) > 7 && Math.abs(g.x) < 3) {
        flipSign = g.y > 0 && !/iPhone|iPad|iPod/.test(navigator.userAgent) ? -1 : 1;
        calibrated = true;
      }
      const r = deviceRotation(g.x * flipSign, g.y * flipSign, g.z, this.deviceRot);
      if (r !== this.deviceRot) {
        this.deviceRot = r;
        this.onRotation?.(r);
      }
    });
    return true;
  }

  // Drehung der Aufnahme relativ zur Bildschirmausrichtung (gegen den
  // Uhrzeigersinn, Grad).
  captureRotation() {
    const ui = screen.orientation?.angle ?? window.orientation ?? 0;
    return (((this.deviceRot - ui) % 360) + 360) % 360;
  }

  // Aktuelles Videobild als Canvas, aufrecht gedreht und ggf. gespiegelt.
  grabFrame() {
    const vw = this.video.videoWidth, vh = this.video.videoHeight;
    const rot = this.captureRotation();
    const swap = rot === 90 || rot === 270;
    const c = document.createElement('canvas');
    c.width = swap ? vh : vw;
    c.height = swap ? vw : vh;
    const ctx = c.getContext('2d');
    ctx.translate(c.width / 2, c.height / 2);
    ctx.rotate((-rot * Math.PI) / 180);
    if (this.mirrored) ctx.scale(-1, 1);
    ctx.drawImage(this.video, -vw / 2, -vh / 2, vw, vh);
    return c;
  }
}
