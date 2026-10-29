// RGB-Histogramm mit additiver Überlagerung.

export function drawHistogram(canvas, hist) {
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  if (!w || !h) return;
  if (canvas.width !== Math.round(w * dpr)) {
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
  }
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  if (!hist) return;

  let max = 1;
  for (let c = 0; c < 3; c++) {
    for (let i = 2; i < 254; i++) max = Math.max(max, hist[c][i]);
  }
  const colors = ['rgba(255,80,70,0.75)', 'rgba(70,215,95,0.75)', 'rgba(70,150,255,0.8)'];
  ctx.globalCompositeOperation = 'lighter';
  for (let c = 0; c < 3; c++) {
    ctx.fillStyle = colors[c];
    ctx.beginPath();
    ctx.moveTo(0, h);
    for (let i = 0; i < 256; i++) {
      const v = Math.min(1, Math.sqrt(hist[c][i] / max));
      ctx.lineTo((i / 255) * w, h - v * (h - 4));
    }
    ctx.lineTo(w, h);
    ctx.closePath();
    ctx.fill();
  }
  ctx.globalCompositeOperation = 'source-over';

  // Clipping-Anzeige in den Ecken
  const total = hist[3].reduce((a, b) => a + b, 0) || 1;
  const lowClip = hist[3][0] / total;
  const highClip = hist[3][255] / total;
  ctx.font = '10px system-ui, sans-serif';
  if (lowClip > 0.002) {
    ctx.fillStyle = '#4aa3ff';
    ctx.fillRect(0, 0, 10, 10);
  }
  if (highClip > 0.002) {
    ctx.fillStyle = '#ff5f56';
    ctx.fillRect(w - 10, 0, 10, 10);
  }
}
