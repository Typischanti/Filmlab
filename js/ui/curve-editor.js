// Gradationskurven-Editor (Master + R/G/B).
// Klick fügt einen Punkt hinzu, Ziehen verschiebt, Doppelklick entfernt.

import { makeSpline } from '../core/spline.js';

const COLORS = { master: '#e6e4df', r: '#ff5f56', g: '#4cd964', b: '#4aa3ff' };

export class CurveEditor {
  constructor(canvas, { get, onInput, onCommit }) {
    this.canvas = canvas;
    this.get = get;           // () => settings.curves
    this.onInput = onInput;
    this.onCommit = onCommit;
    this.channel = 'master';
    this.drag = -1;
    this.hist = null;
    this.pad = 8;
    canvas.addEventListener('pointerdown', (e) => this.down(e));
    canvas.addEventListener('pointermove', (e) => this.move(e));
    canvas.addEventListener('pointerup', (e) => this.up(e));
    canvas.addEventListener('pointercancel', (e) => this.up(e));
    canvas.addEventListener('dblclick', (e) => this.dbl(e));
    new ResizeObserver(() => this.draw()).observe(canvas);
  }

  points() {
    return this.get()[this.channel];
  }

  setChannel(ch) {
    this.channel = ch;
    this.draw();
  }

  setHistogram(h) {
    this.hist = h;
    this.draw();
  }

  toCanvas(p) {
    const s = this.size - 2 * this.pad;
    return [this.pad + p[0] * s, this.pad + (1 - p[1]) * s];
  }

  fromEvent(e) {
    const r = this.canvas.getBoundingClientRect();
    const s = r.width - 2 * this.pad;
    const x = (e.clientX - r.left - this.pad) / s;
    const y = 1 - (e.clientY - r.top - this.pad) / s;
    return [Math.min(1, Math.max(0, x)), Math.min(1, Math.max(0, y))];
  }

  hit(e) {
    const r = this.canvas.getBoundingClientRect();
    const pts = this.points();
    const s = r.width - 2 * this.pad;
    let best = -1, bd = 12;
    pts.forEach((p, i) => {
      const dx = this.pad + p[0] * s - (e.clientX - r.left);
      const dy = this.pad + (1 - p[1]) * s - (e.clientY - r.top);
      const d = Math.hypot(dx, dy);
      if (d < bd) { bd = d; best = i; }
    });
    return best;
  }

  down(e) {
    e.preventDefault();
    this.canvas.setPointerCapture(e.pointerId);
    let i = this.hit(e);
    const pts = this.points();
    if (i < 0) {
      const [x] = this.fromEvent(e);
      const f = makeSpline(pts);
      const np = [x, Math.min(1, Math.max(0, f(x)))];
      pts.push(np);
      pts.sort((a, b) => a[0] - b[0]);
      i = pts.indexOf(np);
      this.onInput();
    }
    this.drag = i;
    this.draw();
  }

  move(e) {
    if (this.drag < 0) return;
    const pts = this.points();
    const [x, y] = this.fromEvent(e);
    const i = this.drag;
    const minX = i > 0 ? pts[i - 1][0] + 0.01 : 0;
    const maxX = i < pts.length - 1 ? pts[i + 1][0] - 0.01 : 1;
    pts[i] = [Math.min(maxX, Math.max(minX, x)), y];
    this.onInput();
    this.draw();
  }

  up() {
    if (this.drag >= 0) {
      this.drag = -1;
      this.onCommit();
    }
  }

  dbl(e) {
    const i = this.hit(e);
    const pts = this.points();
    if (i > 0 && i < pts.length - 1) {
      pts.splice(i, 1);
      this.onInput();
      this.onCommit();
      this.draw();
    }
  }

  draw() {
    const c = this.canvas;
    const dpr = window.devicePixelRatio || 1;
    const w = c.clientWidth;
    if (!w) return;
    this.size = w;
    if (c.width !== Math.round(w * dpr)) {
      c.width = Math.round(w * dpr);
      c.height = Math.round(w * dpr);
    }
    const ctx = c.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, w);
    const pad = this.pad;
    const s = w - 2 * pad;

    // Histogramm im Hintergrund
    if (this.hist) {
      const h = this.hist[this.channel === 'master' ? 3 : { r: 0, g: 1, b: 2 }[this.channel]];
      let max = 1;
      for (let i = 1; i < 255; i++) max = Math.max(max, h[i]);
      ctx.fillStyle = 'rgba(255,255,255,0.07)';
      ctx.beginPath();
      ctx.moveTo(pad, pad + s);
      for (let i = 0; i < 256; i++) ctx.lineTo(pad + (i / 255) * s, pad + s - Math.min(1, Math.sqrt(h[i] / max)) * s * 0.9);
      ctx.lineTo(pad + s, pad + s);
      ctx.fill();
    }

    // Raster
    ctx.strokeStyle = 'rgba(255,255,255,0.08)';
    ctx.lineWidth = 1;
    for (let i = 1; i < 4; i++) {
      const p = pad + (s * i) / 4;
      ctx.beginPath(); ctx.moveTo(p, pad); ctx.lineTo(p, pad + s); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(pad, p); ctx.lineTo(pad + s, p); ctx.stroke();
    }
    ctx.strokeStyle = 'rgba(255,255,255,0.15)';
    ctx.beginPath(); ctx.moveTo(pad, pad + s); ctx.lineTo(pad + s, pad); ctx.stroke();

    // andere Kanäle dezent
    const curves = this.get();
    for (const ch of ['master', 'r', 'g', 'b']) {
      if (ch === this.channel) continue;
      const pts = curves[ch];
      if (pts.length === 2 && pts[0][1] === 0 && pts[1][1] === 1 && pts[0][0] === 0 && pts[1][0] === 1) continue;
      this.drawCurve(ctx, pts, COLORS[ch] + '55', 1);
    }
    const pts = this.points();
    this.drawCurve(ctx, pts, COLORS[this.channel], 2);
    for (const p of pts) {
      const [x, y] = this.toCanvas(p);
      ctx.fillStyle = '#111';
      ctx.strokeStyle = COLORS[this.channel];
      ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(x, y, 4.5, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    }
  }

  drawCurve(ctx, pts, color, width) {
    const f = makeSpline(pts);
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    ctx.beginPath();
    for (let i = 0; i <= 128; i++) {
      const x = i / 128;
      const [cx, cy] = this.toCanvas([x, Math.min(1, Math.max(0, f(x)))]);
      if (i === 0) ctx.moveTo(cx, cy); else ctx.lineTo(cx, cy);
    }
    ctx.stroke();
  }
}
