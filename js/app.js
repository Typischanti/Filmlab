// Filmlab – Benutzeroberfläche.

import {
  defaultSettings, normalizeSettings, cloneSettings, buildLUTs, processToFloat, floatToRGBA,
  histogramRGBA, rawToRGBA, sampleArea, codeToLinear, neutralWb, autoExposure, HSL_BANDS,
} from './core/pipeline.js';
import {
  makeMapping, extract, fitDownscale, orientedSize, FULL_RECT, cropPixelSize,
} from './core/geometry.js';
import { renderFull, resolveLevels, analysisImage, PREVIEW_MAX } from './core/render.js';
import { detectFrame, detectFilmType } from './core/autocrop.js';
import { BUILTIN_PRESETS, applyLook, extractLook, loadUserPresets, saveUserPresets } from './core/presets.js';
import { decodeFile, encodeOutput, extensionFor, downloadBlob, pickDirectory, writeToDirectory } from './io.js';
import { el, getPath, setPath, slider, segmented, select, checkbox, section, TRACKS, bandTrack } from './ui/controls.js';
import { CurveEditor } from './ui/curve-editor.js';
import { drawHistogram } from './ui/histogram.js';

const $ = (id) => document.getElementById(id);
const DEFAULTS = defaultSettings();

const state = {
  images: [],
  active: -1,
  mode: 'edit',          // 'edit' | 'crop' | 'pickBase' | 'pickWB'
  before: false,
  holdBefore: false,
  clipWarn: false,
  zoom: null,            // { cx, cy } normiert im ausgerichteten Bild
  clipboard: null,
};

// Dekodierte Bilder (nur die zuletzt benutzten bleiben im Speicher)
const cache = new Map();
const CACHE_LIMIT = 2;
let nextId = 1;

const view = {
  img: null, key: '', lutKey: '', luts: null, buf: null, imageData: null,
  rect: FULL_RECT, scale: 1, outW: 0, outH: 0, hist: null,
};

const canvas = $('canvas');
const ctx = canvas.getContext('2d');
const stage = $('stage');

// ---------------------------------------------------------------------------
// Hilfen

function active() {
  return state.images[state.active] || null;
}

function S() {
  return active()?.settings;
}

let toastTimer = 0;
function toast(msg, isError = false, ms = 2600) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.toggle('error', isError);
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, ms);
}

function busy(text) {
  $('busy').hidden = !text;
  if (text) $('busyText').textContent = text;
}

const nextFrame = () => new Promise((r) => setTimeout(r, 0));

function storageKey(entry) {
  return `filmlab:img:${entry.name}:${entry.size}`;
}

function persist(entry) {
  try {
    localStorage.setItem(storageKey(entry), JSON.stringify(entry.settings));
  } catch { /* Speicher voll oder deaktiviert */ }
}

function restore(entry) {
  try {
    const raw = localStorage.getItem(storageKey(entry));
    return raw ? normalizeSettings(JSON.parse(raw)) : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Laden

async function addFiles(files) {
  const list = [...files].filter((f) => /\.(tiff?|jpe?g|png|webp|bmp)$/i.test(f.name) || f.type.startsWith('image/'));
  if (!list.length) {
    toast('Keine unterstützten Bilddateien gefunden.', true);
    return;
  }
  const firstNew = state.images.length;
  for (const file of list) {
    const entry = {
      id: nextId++, name: file.name, size: file.size, file,
      settings: null, restored: false, undo: [], redo: [], committed: '',
      thumb: null, info: null, levelsKey: '',
    };
    const saved = restore(entry);
    entry.settings = saved || defaultSettings();
    entry.restored = !!saved;
    entry.committed = JSON.stringify(entry.settings);
    state.images.push(entry);
  }
  renderStrip();
  await selectImage(firstNew);
  // Vorschaubilder der übrigen Bilder im Hintergrund erzeugen
  for (let i = firstNew; i < state.images.length; i++) {
    const e = state.images[i];
    if (!e.thumb && i !== state.active) {
      try {
        const dec = await getDecoded(e, false);
        await prepareNew(e, dec);
        await updateThumb(e, dec);
      } catch (err) {
        console.warn(err);
      }
    }
  }
}

async function getDecoded(entry, keep = true) {
  if (cache.has(entry.id)) {
    const d = cache.get(entry.id);
    cache.delete(entry.id);
    cache.set(entry.id, d);
    return d;
  }
  const full = await decodeFile(entry.file);
  const preview = fitDownscale(full, PREVIEW_MAX);
  entry.info = { width: full.width, height: full.height, bitDepth: full.bitDepth || 16 };
  const dec = { full, preview };
  if (keep) {
    cache.set(entry.id, dec);
    while (cache.size > CACHE_LIMIT) {
      const oldest = cache.keys().next().value;
      if (oldest === active()?.id) break;
      cache.delete(oldest);
    }
  }
  return dec;
}

// Einmalige Automatik für neu geladene Bilder.
async function prepareNew(entry, dec) {
  if (entry.restored || entry.prepared) return;
  entry.prepared = true;
  const s = entry.settings;
  // S/W-Negative erkennen
  if (detectFilmType(dec.preview) === 'bw') {
    s.film.type = 'bw';
    entry.autoBW = true;
  }
  // Bildfeld erkennen, damit Filmhalter und Filmrand die Analyse nicht stören
  if (!s.geometry.crop) {
    const rect = detectFrame(dec.preview, s);
    if (rect) {
      s.geometry.crop = rect;
      entry.autoCropped = true;
    }
  }
  const levels = resolveLevels(dec.preview, s);
  s.film.levels = levels;
  s.tone.exposure = autoExposure(analysisImage(dec.preview, s), s, levels);
  entry.committed = JSON.stringify(s);
}

async function selectImage(index) {
  if (index < 0 || index >= state.images.length) return;
  state.active = index;
  state.zoom = null;
  setMode('edit');
  const entry = active();
  renderStrip();
  $('welcome').hidden = true;
  if (!cache.has(entry.id)) busy(`Lade ${entry.name} …`);
  try {
    const dec = await getDecoded(entry);
    if (active() !== entry) return;
    await prepareNew(entry, dec);
    if (entry.autoCropped || entry.autoBW) {
      const parts = [];
      if (entry.autoBW) parts.push('S/W-Negativ erkannt');
      if (entry.autoCropped) parts.push('Bildfeld automatisch erkannt – anpassen mit „Zuschneiden“ (C)');
      entry.autoCropped = entry.autoBW = false;
      toast(parts.join(' · '), false, 4000);
    }
    view.key = '';
    view.lutKey = '';
    syncPanel();
    render();
    updateThumb(entry, dec);
  } catch (err) {
    console.error(err);
    toast(`${entry.name}: ${err.message}`, true, 5000);
  } finally {
    busy(null);
  }
  updateButtons();
}

function removeImage(index) {
  const [e] = state.images.splice(index, 1);
  cache.delete(e.id);
  if (!state.images.length) {
    state.active = -1;
    $('welcome').hidden = false;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    canvas.width = 0;
    drawHistogram($('histogram'), null);
    renderStrip();
    updateButtons();
    updateStatus();
    return;
  }
  if (index <= state.active) state.active = Math.max(0, state.active - (index < state.active ? 1 : 0));
  if (state.active >= state.images.length) state.active = state.images.length - 1;
  selectImage(state.active);
}

// Beispiel: simuliertes Farbnegativ
async function loadSample() {
  try {
    busy('Lade Beispiel …');
    const res = await fetch('assets/sample-negative.jpg');
    if (!res.ok) throw new Error('Beispieldatei nicht gefunden');
    const blob = await res.blob();
    await addFiles([new File([blob], 'Beispiel-Negativ.jpg', { type: 'image/jpeg' })]);
  } catch (err) {
    toast(err.message, true);
  } finally {
    busy(null);
  }
}

// ---------------------------------------------------------------------------
// Historie

function commit() {
  const e = active();
  if (!e) return;
  const now = JSON.stringify(e.settings);
  if (now === e.committed) return;
  e.undo.push(e.committed);
  if (e.undo.length > 200) e.undo.shift();
  e.redo = [];
  e.committed = now;
  persist(e);
  scheduleThumb();
  updateButtons();
}

function undo() {
  const e = active();
  if (!e || !e.undo.length) return;
  e.redo.push(e.committed);
  e.committed = e.undo.pop();
  e.settings = JSON.parse(e.committed);
  afterExternalChange();
}

function redo() {
  const e = active();
  if (!e || !e.redo.length) return;
  e.undo.push(e.committed);
  e.committed = e.redo.pop();
  e.settings = JSON.parse(e.committed);
  afterExternalChange();
}

function afterExternalChange() {
  const e = active();
  persist(e);
  syncPanel();
  scheduleRender();
  scheduleThumb();
  updateButtons();
}

function changed() {
  scheduleRender();
}

// ---------------------------------------------------------------------------
// Rendern

let renderQueued = false;
function scheduleRender() {
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => {
    renderQueued = false;
    render();
  });
}

function analysisKey(s) {
  const f = s.film;
  const g = s.geometry;
  return JSON.stringify([f.type, f.inputGamma, f.base, f.blackMode, f.clipBlack, f.clipWhite, f.border, f.linked, f.autoNeutral, g.rotation, g.flipH, g.flipV, g.angle, g.crop]);
}

function ensureLevels(entry, dec) {
  const s = entry.settings;
  if (s.film.lockLevels && s.film.levels) return s.film.levels;
  const key = analysisKey(s);
  if (key !== entry.levelsKey || !s.film.levels) {
    s.film.levels = resolveLevels(dec.preview, s);
    entry.levelsKey = key;
  }
  return s.film.levels;
}

function stageSize() {
  const dpr = window.devicePixelRatio || 1;
  const pad = 24;
  return [Math.max(50, (stage.clientWidth - pad * 2) * dpr), Math.max(50, (stage.clientHeight - pad * 2) * dpr), dpr];
}

// Bestimmt Quelle, Ausschnitt und Ausgabegröße der aktuellen Ansicht.
function computeView(entry, dec) {
  const s = entry.settings;
  const g = s.geometry;
  const [sw, sh, dpr] = stageSize();
  const showFull = state.mode === 'crop' || state.mode === 'pickBase';
  const crop = showFull ? FULL_RECT : (g.crop || FULL_RECT);
  const [OWf, OHf] = orientedSize(dec.full.width, dec.full.height, g.rotation);
  if (state.zoom && !showFull) {
    const rw = Math.min(crop.w, sw / OWf);
    const rh = Math.min(crop.h, sh / OHf);
    const z = state.zoom;
    z.cx = Math.min(crop.x + crop.w - rw / 2, Math.max(crop.x + rw / 2, z.cx));
    z.cy = Math.min(crop.y + crop.h - rh / 2, Math.max(crop.y + rh / 2, z.cy));
    const rect = { x: z.cx - rw / 2, y: z.cy - rh / 2, w: rw, h: rh };
    const outW = Math.max(1, Math.round(rw * OWf));
    const outH = Math.max(1, Math.round(rh * OHf));
    return { src: dec.full, rect, outW, outH, scale: 1, dpr, origin: [Math.round((rect.x - crop.x) * OWf), Math.round((rect.y - crop.y) * OHf)] };
  }
  const [OWp, OHp] = orientedSize(dec.preview.width, dec.preview.height, g.rotation);
  const pw = crop.w * OWp;
  const ph = crop.h * OHp;
  const fit = Math.min(sw / pw, sh / ph, 1);
  const outW = Math.max(1, Math.round(pw * fit));
  const outH = Math.max(1, Math.round(ph * fit));
  return { src: dec.preview, rect: crop, outW, outH, scale: outW / (crop.w * OWf), dpr, origin: [0, 0] };
}

function render() {
  const entry = active();
  if (!entry) return;
  const dec = cache.get(entry.id);
  if (!dec) return;
  const s = entry.settings;
  const levels = ensureLevels(entry, dec);
  const v = computeView(entry, dec);
  const g = s.geometry;
  const key = JSON.stringify([entry.id, v.src === dec.full, v.rect, v.outW, v.outH, g.rotation, g.flipH, g.flipV, g.angle]);
  if (key !== view.key) {
    view.img = extract(v.src, makeMapping(v.src, g, v.rect, v.outW, v.outH), v.outW, 0, v.outH);
    view.key = key;
    view.imageData = ctx.createImageData(v.outW, v.outH);
  }
  Object.assign(view, { rect: v.rect, scale: v.scale, outW: v.outW, outH: v.outH, origin: v.origin });

  const out = view.imageData.data;
  const showBefore = state.before || state.holdBefore;
  if (showBefore) {
    rawToRGBA(view.img, out);
  } else {
    const lutKey = JSON.stringify([s.film, s.tone, s.wb, s.curves, levels]);
    if (lutKey !== view.lutKey) {
      view.luts = buildLUTs(s, levels);
      view.lutKey = lutKey;
    }
    view.buf = processToFloat(view.img, s, levels, view.luts, { scale: v.scale, origin: v.origin, buffer: view.buf });
    floatToRGBA(view.buf, out, { clipWarn: state.clipWarn });
  }

  if (canvas.width !== v.outW || canvas.height !== v.outH) {
    canvas.width = v.outW;
    canvas.height = v.outH;
  }
  canvas.style.width = `${v.outW / v.dpr}px`;
  canvas.style.height = `${v.outH / v.dpr}px`;
  ctx.putImageData(view.imageData, 0, 0);

  if (!showBefore) {
    view.hist = histogramRGBA(out);
    drawHistogram($('histogram'), view.hist);
    curveEditor?.setHistogram(view.hist);
  }
  stage.classList.toggle('zoomed', !!state.zoom && state.mode === 'edit');
  if (state.mode === 'crop') positionCropOverlay();
  updateStatus();
}

// ---------------------------------------------------------------------------
// Vorschaubilder im Filmstreifen

let thumbTimer = 0;
function scheduleThumb() {
  clearTimeout(thumbTimer);
  thumbTimer = setTimeout(() => {
    const e = active();
    const dec = e && cache.get(e.id);
    if (dec) updateThumb(e, dec);
  }, 600);
}

async function updateThumb(entry, dec) {
  const s = entry.settings;
  const levels = s.film.lockLevels && s.film.levels ? s.film.levels : resolveLevels(dec.preview, s);
  const res = await renderFull(dec.preview, s, { levels, maxDim: 220 });
  const c = document.createElement('canvas');
  c.width = res.width;
  c.height = res.height;
  const cx = c.getContext('2d');
  const id = cx.createImageData(res.width, res.height);
  floatToRGBA(res.rgb, id.data);
  cx.putImageData(id, 0, 0);
  entry.thumb = c.toDataURL('image/jpeg', 0.85);
  renderStrip();
}

function renderStrip() {
  const strip = $('strip');
  strip.replaceChildren(...state.images.map((e, i) => {
    const t = el('button', {
      class: 'thumb' + (i === state.active ? ' active' : ''), type: 'button', title: e.name,
      onclick: () => i !== state.active && selectImage(i),
    },
    e.thumb ? el('img', { src: e.thumb, alt: '' }) : null,
    e.settings.film.lockLevels ? el('span', { class: 'tbadge', title: 'Analyse gesperrt' }, 'FIX') : null,
    el('span', { class: 'tname' }, e.name),
    el('span', {
      class: 'tclose', title: 'Aus dem Filmstreifen entfernen', role: 'button',
      onclick: (ev) => { ev.stopPropagation(); removeImage(i); },
    }, '✕'));
    return t;
  }));
  // nur den Filmstreifen scrollen, nicht die Seite
  const act = strip.querySelector('.thumb.active');
  if (act) {
    const l = act.offsetLeft - strip.offsetLeft;
    if (l < strip.scrollLeft) strip.scrollLeft = l - 12;
    else if (l + act.offsetWidth > strip.scrollLeft + strip.clientWidth) strip.scrollLeft = l + act.offsetWidth - strip.clientWidth + 12;
  }
}

// ---------------------------------------------------------------------------
// Status & Buttons

function updateStatus() {
  const e = active();
  $('statusName').textContent = e ? e.name : '';
  if (e?.info) {
    const g = e.settings.geometry;
    const dec = cache.get(e.id);
    const [cw, ch] = dec ? cropPixelSize(dec.full, g) : [e.info.width, e.info.height];
    let txt = `${cw} × ${ch} px · ${e.info.bitDepth} Bit`;
    const lv = e.settings.film.levels;
    if (lv?.clip) {
      const names = ['Rot', 'Grün', 'Blau'];
      const parts = lv.clip.map((c, i) => (c ? `${names[i]} ${(lv.clipFrac[i] * 100).toFixed(1).replace('.', ',')} %` : null)).filter(Boolean);
      txt += ` · ⚠ im Scan beschnitten: ${parts.join(', ')} (wird rekonstruiert)`;
    }
    $('statusInfo').textContent = txt;
  } else {
    $('statusInfo').textContent = '';
  }
  $('statusZoom').textContent = e ? (state.zoom ? '100 %' : `${Math.round(view.scale * 100)} %`) : '';
}

function updateButtons() {
  const e = active();
  $('btnUndo').disabled = !e?.undo.length;
  $('btnRedo').disabled = !e?.redo.length;
  $('btnExport').disabled = !e;
  $('btnCopy').disabled = !e;
  $('btnPaste').disabled = !e || !state.clipboard;
  $('btnSyncAll').disabled = !e || state.images.length < 2;
  $('btnBefore').classList.toggle('on', state.before);
  $('btnClip').classList.toggle('on', state.clipWarn);
  $('btnZoom').classList.toggle('on', !!state.zoom);
  $('btnCrop').classList.toggle('on', state.mode === 'crop');
}

function setMode(mode) {
  state.mode = mode;
  stage.classList.toggle('picking', mode === 'pickBase' || mode === 'pickWB');
  $('cropOverlay').hidden = mode !== 'crop';
  const hint = $('pickHint');
  hint.hidden = !(mode === 'pickBase' || mode === 'pickWB');
  if (mode === 'pickBase') hint.textContent = 'Auf den unbelichteten Filmrand klicken (Esc: abbrechen)';
  if (mode === 'pickWB') hint.textContent = 'Auf etwas Neutrales (Grau/Weiß) klicken (Esc: abbrechen)';
  document.querySelectorAll('[data-pick]').forEach((b) => b.classList.toggle('active-pick', b.dataset.pick === mode));
  updateButtons();
  scheduleRender();
}

// ---------------------------------------------------------------------------
// Panel

const syncers = [];
let curveEditor = null;

function bind(path, opts) {
  const w = slider({
    ...opts,
    get: () => getPath(S() || DEFAULTS, path),
    def: getPath(DEFAULTS, path),
    onInput: (v) => { if (S()) { setPath(S(), path, v); changed(); } },
    onCommit: commit,
  });
  syncers.push(w);
  return w;
}

function reg(w) {
  syncers.push(w);
  return w;
}

function resetKeys(...paths) {
  const s = S();
  if (!s) return;
  for (const p of paths) setPath(s, p, cloneSettings({ v: getPath(DEFAULTS, p) }).v);
  commit();
  afterExternalChange();
}

const sections = {};

function buildPanel() {
  const root = $('controls');

  // --- Film & Scan
  const baseSwatch = el('span', { class: 'swatch', title: 'Gemessene Filmbasis' });
  const baseRow = el('div', { class: 'row' },
    el('button', { class: 'btn small', type: 'button', 'data-pick': 'pickBase', onclick: () => togglePick('pickBase'), title: 'Pipette auf den unbelichteten Filmrand (F)' }, '◎ Filmbasis aufnehmen'),
    baseSwatch,
    el('button', { class: 'btn small', type: 'button', onclick: () => { const s = S(); if (!s) return; s.film.base = null; s.film.blackMode = 'auto'; commit(); afterExternalChange(); } }, 'Entfernen'));
  baseRow.sync = () => {
    const b = S()?.film.base;
    baseSwatch.style.background = b ? `rgb(${b.map((v) => Math.round(Math.pow(v, 1 / 2.2) * 255)).join(',')})` : '';
  };
  syncers.push(baseRow);

  const lockBox = reg(checkbox('Analyse sperren (für die ganze Rolle)', () => S()?.film.lockLevels, (v) => {
    const s = S(); if (!s) return;
    s.film.lockLevels = v;
    commit(); renderStrip(); changed();
  }, 'Friert Schwarz-/Weißpunkte ein. Zusammen mit „Auf alle“ erhalten alle Bilder einer Rolle dieselbe Farbabstimmung.'));

  const chanFine = el('details', { class: 'sub' }, el('summary', {}, 'Kanal-Feinabstimmung (Schwarz-/Weißpunkt R, G, B)'),
    el('div', { style: 'display:grid;gap:8px' },
      ['Rot', 'Grün', 'Blau'].flatMap((n, c) => [
        bind(`film.chanBlack.${c}`, { label: `${n} – Schwarzpunkt`, min: -100, max: 100, step: 1 }),
        bind(`film.chanWhite.${c}`, { label: `${n} – Weißpunkt`, min: -100, max: 100, step: 1 }),
      ])));

  const filmBody = [
    reg(segmented([
      ['color', 'Farbnegativ', 'C-41 Farbnegativfilm mit oranger Maske'],
      ['bw', 'S/W-Negativ', 'Schwarzweiß-Negativfilm'],
      ['positive', 'Dia / Positiv', 'Diafilm (E-6) oder bereits positive Scans'],
    ], () => S()?.film.type, (v) => {
      const s = S(); if (!s) return;
      s.film.type = v;
      s.film.linked = v === 'positive';
      commit(); syncPanel(); changed();
    })),
    el('div', { class: 'row' }, el('span', { class: 'grow hint' }, 'Scan-Kodierung'),
      reg(select([['srgb', 'Gamma (normaler Scan, JPEG)'], ['linear', 'Linear (RAW-/Linear-TIFF)']],
        () => S()?.film.inputGamma, (v) => { const s = S(); if (!s) return; s.film.inputGamma = v; commit(); changed(); }))),
    el('div', { class: 'base-only', style: 'display:grid;gap:8px' },
      baseRow,
      el('div', { class: 'row' }, el('span', { class: 'grow hint' }, 'Schwarzpunkt'),
        reg(select([['auto', 'Automatisch'], ['base', 'Farbneutral aus Filmbasis']],
          () => S()?.film.blackMode, (v) => { const s = S(); if (!s) return; s.film.blackMode = v; commit(); changed(); })))),
    bind('film.clipBlack', { label: 'Schwarz-Clipping', min: 0, max: 2, step: 0.01, unit: ' %', title: 'Anteil der Pixel, die rein schwarz werden dürfen' }),
    bind('film.clipWhite', { label: 'Weiß-Clipping', min: 0, max: 2, step: 0.01, unit: ' %', title: 'Anteil der Pixel, die rein weiß werden dürfen' }),
    bind('film.border', { label: 'Analyse-Rand ignorieren', min: 0, max: 20, step: 1, unit: ' %' }),
    reg(checkbox('Automatische Graubalance', () => S()?.film.autoNeutral !== false, (v) => {
      const s = S(); if (!s) return;
      s.film.autoNeutral = v;
      commit(); changed();
    }, 'Entfernt einen Reststich anhand fast neutraler Motivteile (Wolken, Asphalt, Weißes). Kräftige Farben bleiben unberührt.')),
    reg(checkbox('Kanäle gekoppelt analysieren', () => S()?.film.linked, (v) => {
      const s = S(); if (!s) return;
      s.film.linked = v;
      commit(); changed();
    }, 'Erhält die Farbbalance des Scans (Standard bei Dias). Aus: jede Farbschicht wird einzeln kalibriert (ideal für Farbnegative).')),
    lockBox,
    chanFine,
  ];
  sections.film = section('Film & Scan', true, filmBody, () => {
    const s = S(); if (!s) return;
    s.film = cloneSettings(DEFAULTS.film);
    commit(); afterExternalChange();
  });

  // --- Weißabgleich
  sections.wb = section('Weißabgleich', true, [
    el('div', { class: 'row' },
      el('button', { class: 'btn small', type: 'button', 'data-pick': 'pickWB', onclick: () => togglePick('pickWB'), title: 'Pipette (W)' }, '◎ Neutralen Punkt wählen'),
      el('button', { class: 'btn small', type: 'button', onclick: () => resetKeys('wb.temp', 'wb.tint') }, 'Auto')),
    bind('wb.temp', { label: 'Temperatur', min: -100, max: 100, step: 1, track: TRACKS.temp }),
    bind('wb.tint', { label: 'Tönung', min: -100, max: 100, step: 1, track: TRACKS.tint }),
    el('p', { class: 'hint' }, '„Auto“ = neutrale Kanalabstimmung aus der Analyse. Die Verschiebung erfolgt im Belichtungsraum – wie ein Farbfilter im Vergrößerer.'),
  ], () => resetKeys('wb'));

  // --- Ton
  sections.tone = section('Belichtung & Kontrast', true, [
    el('div', { class: 'row' }, el('button', { class: 'btn small', type: 'button', onclick: doAutoExposure }, 'Auto-Belichtung')),
    bind('tone.exposure', { label: 'Belichtung', min: -3, max: 3, step: 0.05, unit: ' EV', digits: 2, track: TRACKS.exposure }),
    bind('tone.contrast', { label: 'Kontrast', min: -100, max: 100, step: 1 }),
    bind('tone.range', { label: 'Tonumfang (Papiergradation)', min: 4, max: 14, step: 0.1, unit: ' Bl.', title: 'Wie viele Blendenstufen der Negativumfang abbildet – höher = kräftiger' }),
    bind('tone.highlights', { label: 'Lichter', min: -100, max: 100, step: 1 }),
    bind('tone.shadows', { label: 'Tiefen', min: -100, max: 100, step: 1 }),
    bind('tone.whites', { label: 'Weiß', min: -100, max: 100, step: 1 }),
    bind('tone.blacks', { label: 'Schwarz', min: -100, max: 100, step: 1 }),
  ], () => resetKeys('tone'));

  // --- Farbe
  sections.color = section('Farbe', true, [
    bind('color.vibrance', { label: 'Dynamik', min: -100, max: 100, step: 1, title: 'Hebt schwache Farben an, schont Hauttöne und gesättigte Farben' }),
    bind('color.saturation', { label: 'Sättigung', min: -100, max: 100, step: 1, track: TRACKS.sat }),
    el('p', { class: 'hint' }, 'Farben laufen weich gegen die Gamut-Grenze statt zu clippen – kräftig, aber nie grell.'),
  ], () => resetKeys('color'));

  // --- HSL
  const hslTabs = el('div', { class: 'tabs' });
  const hslBody = el('div', { style: 'display:grid;gap:8px' });
  const hslKinds = [['h', 'Farbton'], ['s', 'Sättigung'], ['l', 'Luminanz']];
  const hslGroups = {};
  for (const [k, label] of hslKinds) {
    hslGroups[k] = el('div', { style: 'display:grid;gap:8px' },
      HSL_BANDS.map((b) => bind(`hsl.${b.key}.${k}`, { label: b.label, min: -100, max: 100, step: 1, track: bandTrack(k, b.hue) })));
    hslTabs.append(el('button', { type: 'button', 'data-k': k, onclick: () => showHsl(k) }, label));
    hslBody.append(hslGroups[k]);
  }
  const showHsl = (k) => {
    for (const [kk] of hslKinds) hslGroups[kk].hidden = kk !== k;
    hslTabs.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.k === k));
  };
  showHsl('s');
  sections.hsl = section('Farbmischer (HSL)', false, [hslTabs, hslBody], () => resetKeys('hsl'));

  // --- Color Grading
  const gradeBlock = (key, label) => [
    el('div', { class: 'sublabel' }, label),
    bind(`grading.${key}.hue`, { label: 'Farbton', min: 0, max: 360, step: 1, unit: '°', track: TRACKS.hue }),
    bind(`grading.${key}.sat`, { label: 'Stärke', min: 0, max: 100, step: 1 }),
  ];
  sections.grading = section('Color Grading', false, [
    ...gradeBlock('shadows', 'Tiefen'),
    ...gradeBlock('midtones', 'Mitteltöne'),
    ...gradeBlock('highlights', 'Lichter'),
    bind('grading.balance', { label: 'Balance', min: -100, max: 100, step: 1 }),
  ], () => resetKeys('grading'));

  // --- Kurven
  const curveCanvas = el('canvas', { id: 'curveCanvas' });
  const curveTabs = el('div', { class: 'tabs' });
  for (const [k, label] of [['master', 'RGB'], ['r', 'Rot'], ['g', 'Grün'], ['b', 'Blau']]) {
    curveTabs.append(el('button', {
      type: 'button', 'data-k': k,
      onclick: () => { curveEditor.setChannel(k); curveTabs.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.k === k)); },
    }, label));
  }
  curveTabs.firstChild.classList.add('on');
  sections.curves = section('Gradationskurve', false, [
    curveTabs,
    el('div', { class: 'curve-wrap' }, curveCanvas),
    el('div', { class: 'row' },
      el('span', { class: 'grow hint' }, 'Klicken: Punkt · Ziehen: verschieben · Doppelklick: entfernen'),
      el('button', { class: 'btn small', type: 'button', onclick: () => { const s = S(); if (!s) return; s.curves[curveEditor.channel] = [[0, 0], [1, 1]]; commit(); afterExternalChange(); } }, 'Kanal zurücksetzen')),
  ], () => resetKeys('curves'));

  // --- Details
  sections.detail = section('Details', false, [
    el('div', { class: 'sublabel' }, 'Schärfen'),
    bind('detail.sharpen', { label: 'Betrag', min: 0, max: 100, step: 1 }),
    bind('detail.radius', { label: 'Radius', min: 0.5, max: 3, step: 0.1, unit: ' px' }),
    bind('detail.threshold', { label: 'Maskierung', min: 0, max: 20, step: 1, title: 'Schützt glatte Flächen (Korn, Himmel) vor dem Schärfen' }),
    el('div', { class: 'sublabel' }, 'Körnung'),
    bind('detail.grain', { label: 'Stärke', min: 0, max: 100, step: 1 }),
    bind('detail.grainSize', { label: 'Größe', min: 0.5, max: 3, step: 0.1 }),
    el('p', { class: 'hint' }, 'Tipp: Schärfe in der 1:1-Ansicht beurteilen (Z).'),
  ], () => resetKeys('detail'));

  // --- Geometrie
  const aspectSel = reg(select([
    ['free', 'Frei'], ['orig', 'Original'], ['3:2', '3:2 (Kleinbild)'], ['4:3', '4:3 (6×4,5)'], ['1:1', '1:1 (6×6)'],
    ['7:6', '7:6 (6×7)'], ['5:4', '5:4 (4×5″)'], ['16:9', '16:9'], ['65:24', 'XPan (65:24)'],
  ], () => S()?.geometry.aspect, (v) => { const s = S(); if (!s) return; s.geometry.aspect = v; applyAspect(); commit(); changed(); }));
  sections.geometry = section('Zuschneiden & Drehen', false, [
    el('div', { class: 'row' },
      el('button', { class: 'btn small', type: 'button', onclick: () => rotate(-90), title: 'Links drehen' }, '⟲ 90°'),
      el('button', { class: 'btn small', type: 'button', onclick: () => rotate(90), title: 'Rechts drehen' }, '⟳ 90°'),
      el('button', { class: 'btn small', type: 'button', onclick: () => flip('flipH'), title: 'Horizontal spiegeln (Schichtseite)' }, '⇋ Spiegeln'),
      el('button', { class: 'btn small', type: 'button', onclick: () => flip('flipV'), title: 'Vertikal spiegeln' }, '⇵')),
    bind('geometry.angle', { label: 'Begradigen', min: -15, max: 15, step: 0.1, unit: '°' }),
    el('div', { class: 'row' }, el('span', { class: 'grow hint' }, 'Seitenverhältnis'), aspectSel,
      el('button', { class: 'btn small', type: 'button', title: 'Hoch-/Querformat tauschen', onclick: swapAspect }, '↻')),
    el('div', { class: 'row' },
      el('button', { class: 'btn small', type: 'button', onclick: () => setMode(state.mode === 'crop' ? 'edit' : 'crop') }, 'Zuschnitt bearbeiten (C)'),
      el('button', { class: 'btn small', type: 'button', onclick: () => { const s = S(); if (!s) return; s.geometry.crop = null; s.geometry.angle = 0; commit(); afterExternalChange(); } }, 'Zuschnitt entfernen')),
    el('div', { class: 'row' },
      el('button', { class: 'btn small', type: 'button', onclick: autoFrame, title: 'Filmhalter, Filmrand und Leuchtpult automatisch wegschneiden' }, '⌖ Bildfeld automatisch erkennen')),
  ], () => resetKeys('geometry'));

  root.append(...Object.values(sections));

  curveEditor = new CurveEditor(curveCanvas, {
    get: () => (S() || DEFAULTS).curves,
    onInput: changed,
    onCommit: commit,
  });
  sections.curves.addEventListener('toggle', () => curveEditor.draw());
}

function syncPanel() {
  for (const w of syncers) w.sync?.();
  const s = S();
  const type = s?.film.type || 'color';
  sections.wb.hidden = type === 'bw';
  sections.color.hidden = type === 'bw';
  sections.hsl.hidden = type === 'bw';
  document.querySelectorAll('.base-only').forEach((e) => { e.hidden = type !== 'color'; });
  curveEditor?.draw();
  updateButtons();
}

// ---------------------------------------------------------------------------
// Werkzeuge

function togglePick(mode) {
  if (!active()) return;
  setMode(state.mode === mode ? 'edit' : mode);
}

function doAutoExposure() {
  const e = active();
  const dec = e && cache.get(e.id);
  if (!dec) return;
  const s = e.settings;
  const levels = ensureLevels(e, dec);
  s.tone.exposure = autoExposure(analysisImage(dec.preview, s), s, levels);
  commit();
  afterExternalChange();
}

function autoFrame() {
  const e = active();
  const dec = e && cache.get(e.id);
  if (!dec) return;
  const rect = detectFrame(dec.preview, e.settings);
  if (!rect) {
    toast('Kein Rahmen erkannt – das Bild scheint bereits randlos zu sein.');
    return;
  }
  e.settings.geometry.crop = rect;
  e.settings.geometry.aspect = 'free';
  commit();
  afterExternalChange();
  toast('Bildfeld erkannt.');
}

function rotate(deg) {
  const s = S();
  if (!s) return;
  const g = s.geometry;
  // Bei einseitiger Spiegelung muss die interne Drehung gegenläufig sein,
  // damit sich das Bild auf dem Bildschirm in die gewünschte Richtung dreht.
  const internal = g.flipH !== g.flipV ? -deg : deg;
  g.rotation = (((g.rotation + internal) % 360) + 360) % 360;
  // Zuschnitt mitdrehen (in Bildschirmkoordinaten)
  if (g.crop) {
    const c = g.crop;
    g.crop = deg > 0
      ? { x: 1 - c.y - c.h, y: c.x, w: c.h, h: c.w }
      : { x: c.y, y: 1 - c.x - c.w, w: c.h, h: c.w };
  }
  state.zoom = null;
  commit();
  afterExternalChange();
}

function flip(key) {
  const s = S();
  if (!s) return;
  const g = s.geometry;
  g[key] = !g[key];
  if (g.crop) {
    const c = g.crop;
    g.crop = key === 'flipH' ? { ...c, x: 1 - c.x - c.w } : { ...c, y: 1 - c.y - c.h };
  }
  commit();
  afterExternalChange();
}

function aspectRatio(entry) {
  const a = entry.settings.geometry.aspect;
  if (a === 'free') return null;
  const dec = cache.get(entry.id);
  if (!dec) return null;
  const [OW, OH] = orientedSize(dec.full.width, dec.full.height, entry.settings.geometry.rotation);
  if (a === 'orig') return OW / OH;
  const [w, h] = a.split(':').map(Number);
  const r = w / h;
  // Ausrichtung folgt dem aktuellen Zuschnitt bzw. dem Bild
  const c = entry.settings.geometry.crop || FULL_RECT;
  const landscape = c.w * OW >= c.h * OH;
  return landscape ? Math.max(r, 1 / r) : Math.min(r, 1 / r);
}

// Größtes Rechteck mit Seitenverhältnis im aktuellen Zuschnitt.
function applyAspect(forceRatio) {
  const e = active();
  if (!e) return;
  const dec = cache.get(e.id);
  if (!dec) return;
  const r = forceRatio ?? aspectRatio(e);
  if (!r) return;
  const g = e.settings.geometry;
  const [OW, OH] = orientedSize(dec.full.width, dec.full.height, g.rotation);
  const c = g.crop || FULL_RECT;
  let w = c.w, h = (c.w * OW) / (OH * r);
  if (h > c.h) { h = c.h; w = (c.h * OH * r) / OW; }
  g.crop = { x: c.x + (c.w - w) / 2, y: c.y + (c.h - h) / 2, w, h };
}

function swapAspect() {
  const e = active();
  if (!e) return;
  const dec = cache.get(e.id);
  if (!dec) return;
  const g = e.settings.geometry;
  const [OW, OH] = orientedSize(dec.full.width, dec.full.height, g.rotation);
  const c = g.crop || FULL_RECT;
  const cur = (c.w * OW) / (c.h * OH);
  // neues Rechteck um die Mitte, so groß wie möglich
  const r = 1 / cur;
  const cx = c.x + c.w / 2, cy = c.y + c.h / 2;
  let w = 1, h = OW / (OH * r);
  if (h > 1) { h = 1; w = (OH * r) / OW; }
  g.crop = { x: Math.min(1 - w, Math.max(0, cx - w / 2)), y: Math.min(1 - h, Math.max(0, cy - h / 2)), w, h };
  commit();
  afterExternalChange();
}

// ---------------------------------------------------------------------------
// Zuschnitt-Overlay

function positionCropOverlay() {
  const o = $('cropOverlay');
  const cr = canvas.getBoundingClientRect();
  const sr = stage.getBoundingClientRect();
  o.style.left = `${cr.left - sr.left}px`;
  o.style.top = `${cr.top - sr.top}px`;
  o.style.width = `${cr.width}px`;
  o.style.height = `${cr.height}px`;
  const c = S()?.geometry.crop || FULL_RECT;
  const r = $('cropRect');
  r.style.left = `${c.x * 100}%`;
  r.style.top = `${c.y * 100}%`;
  r.style.width = `${c.w * 100}%`;
  r.style.height = `${c.h * 100}%`;
}

function initCrop() {
  const overlay = $('cropOverlay');
  let drag = null;
  overlay.addEventListener('pointerdown', (e) => {
    const s = S();
    if (!s) return;
    const handle = e.target.dataset.h || (e.target.closest('#cropRect') ? 'move' : 'new');
    const r = overlay.getBoundingClientRect();
    const nx = (e.clientX - r.left) / r.width;
    const ny = (e.clientY - r.top) / r.height;
    const start = { ...(s.geometry.crop || FULL_RECT) };
    drag = { handle, nx, ny, start, w: r.width, h: r.height };
    if (handle === 'new') drag.start = { x: nx, y: ny, w: 0, h: 0 };
    overlay.setPointerCapture(e.pointerId);
    e.preventDefault();
  });
  overlay.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const e0 = active();
    const s = e0.settings;
    const dx = (e.clientX - overlay.getBoundingClientRect().left) / drag.w - drag.nx;
    const dy = (e.clientY - overlay.getBoundingClientRect().top) / drag.h - drag.ny;
    const st = drag.start;
    let L = st.x, T = st.y, R = st.x + st.w, B = st.y + st.h;
    const hd = drag.handle;
    if (hd === 'move') {
      const nx = Math.min(1 - st.w, Math.max(0, st.x + dx));
      const ny = Math.min(1 - st.h, Math.max(0, st.y + dy));
      s.geometry.crop = { x: nx, y: ny, w: st.w, h: st.h };
    } else {
      if (hd === 'new') { R = st.x + dx; B = st.y + dy; }
      if (hd.includes('w')) L = st.x + dx;
      if (hd.includes('e')) R = st.x + st.w + dx;
      if (hd.includes('n')) T = st.y + dy;
      if (hd.includes('s')) B = st.y + st.h + dy;
      if (L > R) [L, R] = [R, L];
      if (T > B) [T, B] = [B, T];
      L = Math.max(0, L); T = Math.max(0, T); R = Math.min(1, R); B = Math.min(1, B);
      let w = Math.max(0.02, R - L), h = Math.max(0.02, B - T);
      const ratio = aspectRatio(e0);
      if (ratio) {
        const dec = cache.get(e0.id);
        const [OW, OH] = orientedSize(dec.full.width, dec.full.height, s.geometry.rotation);
        const k = OW / (OH * ratio); // h = w * k
        if (hd === 'n' || hd === 's') w = h / k;
        else h = w * k;
        // Grenzen einhalten
        const maxW = hd.includes('w') ? R : 1 - L;
        const maxH = hd.includes('n') ? B : 1 - T;
        if (w > maxW) { w = maxW; h = w * k; }
        if (h > maxH) { h = maxH; w = h / k; }
        if (hd.includes('w')) L = R - w;
        if (hd.includes('n')) T = B - h;
        if (hd === 'n' || hd === 's') L = Math.min(1 - w, Math.max(0, st.x + st.w / 2 - w / 2));
        if (hd === 'e' || hd === 'w') T = Math.min(1 - h, Math.max(0, st.y + st.h / 2 - h / 2));
      }
      s.geometry.crop = { x: L, y: T, w, h };
    }
    positionCropOverlay();
    updateStatus();
  });
  const end = () => {
    if (!drag) return;
    drag = null;
    const s = S();
    const c = s?.geometry.crop;
    if (c && (c.w > 0.995 && c.h > 0.995)) s.geometry.crop = null;
    commit();
    scheduleRender();
  };
  overlay.addEventListener('pointerup', end);
  overlay.addEventListener('pointercancel', end);
  overlay.addEventListener('dblclick', () => setMode('edit'));
}

// ---------------------------------------------------------------------------
// Interaktion mit dem Bild

function canvasToView(e) {
  const r = canvas.getBoundingClientRect();
  const u = Math.floor(((e.clientX - r.left) / r.width) * view.outW);
  const v = Math.floor(((e.clientY - r.top) / r.height) * view.outH);
  if (u < 0 || v < 0 || u >= view.outW || v >= view.outH) return null;
  return [u, v];
}

function initCanvas() {
  let pan = null;
  canvas.addEventListener('pointerdown', (e) => {
    const entry = active();
    if (!entry || !view.img) return;
    const p = canvasToView(e);
    if (state.mode === 'pickBase' || state.mode === 'pickWB') {
      if (!p) return;
      const radius = Math.max(2, Math.round(4 * (window.devicePixelRatio || 1)));
      const codes = sampleArea(view.img, p[0], p[1], radius);
      const s = entry.settings;
      if (state.mode === 'pickBase') {
        s.film.base = codes.map((c) => codeToLinear(c, s.film.inputGamma));
        if (Math.max(...codes) > 64500) {
          // übersteuerte Basis liefert falsche Farben -> Automatik behalten
          s.film.blackMode = 'auto';
          toast('Die Filmbasis ist im Scan übersteuert (ein Kanal bei 100 %). Der automatische Schwarzpunkt bleibt aktiv – beim nächsten Scan etwas knapper belichten.', true, 7000);
        } else {
          s.film.blackMode = 'base';
          toast('Filmbasis gemessen – Schatten werden jetzt farbneutral abgestimmt.');
        }
      } else {
        const levels = ensureLevels(entry, cache.get(entry.id));
        s.wb = neutralWb(codes, s, levels);
      }
      setMode('edit');
      commit();
      afterExternalChange();
      return;
    }
    if (state.zoom && state.mode === 'edit') {
      pan = { x: e.clientX, y: e.clientY, cx: state.zoom.cx, cy: state.zoom.cy };
      canvas.setPointerCapture(e.pointerId);
      stage.classList.add('dragging');
    }
  });
  canvas.addEventListener('pointermove', (e) => {
    if (pan) {
      const entry = active();
      const dec = cache.get(entry.id);
      const [OW, OH] = orientedSize(dec.full.width, dec.full.height, entry.settings.geometry.rotation);
      const dpr = window.devicePixelRatio || 1;
      state.zoom.cx = pan.cx - ((e.clientX - pan.x) * dpr) / OW;
      state.zoom.cy = pan.cy - ((e.clientY - pan.y) * dpr) / OH;
      scheduleRender();
      return;
    }
    const p = canvasToView(e);
    if (!p || !view.img) { $('statusPixel').textContent = ''; return; }
    const i = (p[1] * view.outW + p[0]) * 3;
    if (state.before || state.holdBefore || !view.buf) {
      const d = view.img.data;
      $('statusPixel').textContent = `Scan R ${d[i] >> 8} G ${d[i + 1] >> 8} B ${d[i + 2] >> 8}`;
    } else {
      const b = view.buf;
      const f = (x) => String(Math.round(Math.min(1, Math.max(0, x)) * 255)).padStart(3, ' ');
      $('statusPixel').textContent = `R ${f(b[i])}  G ${f(b[i + 1])}  B ${f(b[i + 2])}`;
    }
  });
  const endPan = () => { pan = null; stage.classList.remove('dragging'); };
  canvas.addEventListener('pointerup', endPan);
  canvas.addEventListener('pointercancel', endPan);
  canvas.addEventListener('pointerleave', () => { $('statusPixel').textContent = ''; });
  canvas.addEventListener('dblclick', (e) => {
    if (state.mode !== 'edit') return;
    toggleZoom(e);
  });
}

function toggleZoom(e) {
  const entry = active();
  if (!entry) return;
  if (state.zoom) {
    state.zoom = null;
  } else {
    const c = state.mode === 'edit' ? (entry.settings.geometry.crop || FULL_RECT) : FULL_RECT;
    let fx = 0.5, fy = 0.5;
    if (e && e.clientX != null) {
      const r = canvas.getBoundingClientRect();
      fx = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
      fy = Math.min(1, Math.max(0, (e.clientY - r.top) / r.height));
    }
    state.zoom = { cx: c.x + fx * c.w, cy: c.y + fy * c.h };
    if (state.mode !== 'edit') setMode('edit');
  }
  updateButtons();
  scheduleRender();
}

// ---------------------------------------------------------------------------
// Presets

function buildPresetSelect() {
  const sel = $('presetSelect');
  const user = loadUserPresets();
  sel.replaceChildren(
    el('option', { value: '' }, '– Preset wählen –'),
    el('optgroup', { label: 'Mitgeliefert' }, BUILTIN_PRESETS.map((p) => el('option', { value: 'b:' + p.id }, p.name))),
    user.length ? el('optgroup', { label: 'Eigene' }, user.map((p, i) => el('option', { value: 'u:' + i }, p.name))) : null,
    user.length ? el('option', { value: 'del' }, 'Eigenes Preset löschen …') : null,
  );
}

function applyPresetValue(v) {
  const e = active();
  if (!e || !v) return;
  if (v === 'del') {
    const user = loadUserPresets();
    const name = prompt('Name des zu löschenden Presets:\n' + user.map((p) => '• ' + p.name).join('\n'));
    const idx = user.findIndex((p) => p.name === name);
    if (idx >= 0) {
      user.splice(idx, 1);
      saveUserPresets(user);
      buildPresetSelect();
      toast(`Preset „${name}“ gelöscht.`);
    }
    return;
  }
  const [kind, id] = v.split(':');
  const p = kind === 'b' ? BUILTIN_PRESETS.find((x) => x.id === id) : loadUserPresets()[Number(id)];
  if (!p) return;
  e.settings = applyLook(e.settings, p.look);
  commit();
  afterExternalChange();
  toast(`Look „${p.name}“ angewendet.`);
}

function savePreset() {
  const e = active();
  if (!e) return;
  const name = prompt('Name für das Preset:');
  if (!name) return;
  const user = loadUserPresets().filter((p) => p.name !== name);
  user.push({ name, look: extractLook(e.settings) });
  if (saveUserPresets(user)) toast(`Preset „${name}“ gespeichert.`);
  else toast('Preset konnte nicht gespeichert werden.', true);
  buildPresetSelect();
}

// ---------------------------------------------------------------------------
// Kopieren / Einfügen / Synchronisieren

function transferable(s) {
  const c = cloneSettings(s);
  delete c.geometry;
  return c;
}

function applyTransfer(target, src) {
  const t = cloneSettings(src);
  t.geometry = cloneSettings(target.settings.geometry);
  if (!t.film.lockLevels) t.film.levels = null;
  target.settings = normalizeSettings(t);
  target.levelsKey = '';
  target.restored = true; // keine Auto-Belichtung mehr darüberlegen
  target.prepared = true;
}

function copySettings() {
  const e = active();
  if (!e) return;
  state.clipboard = transferable(e.settings);
  updateButtons();
  toast('Einstellungen kopiert (ohne Zuschnitt).');
}

function pasteSettings() {
  const e = active();
  if (!e || !state.clipboard) return;
  applyTransfer(e, state.clipboard);
  commit();
  afterExternalChange();
  toast('Einstellungen eingefügt.');
}

async function syncAll() {
  const e = active();
  if (!e) return;
  const src = transferable(e.settings);
  const others = state.images.filter((x) => x !== e);
  const hint = e.settings.film.lockLevels
    ? 'inklusive gesperrter Analyse (gleiche Farbabstimmung für alle)'
    : 'jedes Bild wird einzeln analysiert – für identische Abstimmung vorher „Analyse sperren“ aktivieren';
  if (!confirm(`Einstellungen auf ${others.length} weitere Bilder übertragen?\n(${hint}; Zuschnitt bleibt erhalten)`)) return;
  for (const o of others) {
    o.undo.push(o.committed);
    applyTransfer(o, src);
    o.committed = JSON.stringify(o.settings);
    o.redo = [];
    persist(o);
  }
  toast('Einstellungen übertragen.');
  renderStrip();
  for (const o of others) {
    try {
      const dec = await getDecoded(o, false);
      await updateThumb(o, dec);
    } catch { /* ignorieren */ }
  }
}

// ---------------------------------------------------------------------------
// Export

function openExport() {
  if (!active()) return;
  const d = $('exportDialog');
  $('exScope').querySelector('[value="all"]').disabled = state.images.length < 2;
  if (state.images.length < 2) $('exScope').value = 'current';
  updateExportInfo();
  d.showModal();
}

function updateExportInfo() {
  const fmt = $('exFormat').value;
  $('exQuality').disabled = fmt !== 'jpeg';
  const e = active();
  const dec = e && cache.get(e.id);
  let info = '';
  if (dec) {
    let [w, h] = cropPixelSize(dec.full, e.settings.geometry);
    const max = Number($('exSize').value);
    if (max && Math.max(w, h) > max) {
      const k = max / Math.max(w, h);
      w = Math.round(w * k); h = Math.round(h * k);
    }
    info = `Ausgabe: ${w} × ${h} px`;
    if (fmt === 'tiff') info += ` · ca. ${Math.round((w * h * 6) / 1e6)} MB`;
  }
  if (fmt === 'tiff') info += (info ? ' · ' : '') + '16 Bit pro Kanal für maximale Reserven bei der Weiterbearbeitung.';
  $('exInfo').textContent = info;
}

async function doExport() {
  const fmt = $('exFormat').value;
  const quality = Number($('exQuality').value) / 100;
  const maxDim = Number($('exSize').value);
  const suffix = $('exSuffix').value;
  const sidecar = $('exSidecar').checked;
  const targets = $('exScope').value === 'all' ? [...state.images] : [active()];
  let dir = null;
  if (targets.length > 1) {
    try {
      dir = await pickDirectory();
    } catch {
      return; // abgebrochen
    }
  }
  const t0 = performance.now();
  try {
    for (let i = 0; i < targets.length; i++) {
      const e = targets[i];
      const label = targets.length > 1 ? `(${i + 1}/${targets.length}) ` : '';
      busy(`${label}Verarbeite ${e.name} …`);
      await nextFrame();
      const dec = await getDecoded(e, e === active());
      const s = e.settings;
      const levels = s.film.lockLevels && s.film.levels ? s.film.levels : resolveLevels(dec.preview, s);
      const res = await renderFull(dec.full, s, {
        levels, maxDim,
        onProgress: async (p) => { $('busyText').textContent = `${label}Verarbeite ${e.name} … ${Math.round(p * 100)} %`; await nextFrame(); },
      });
      busy(`${label}Speichere ${e.name} …`);
      await nextFrame();
      const blob = await encodeOutput(res, fmt, quality);
      const stem = e.name.replace(/\.[^.]+$/, '') + suffix;
      const name = stem + extensionFor(fmt);
      if (dir) await writeToDirectory(dir, name, blob);
      else downloadBlob(blob, name);
      if (sidecar) {
        const js = new Blob([JSON.stringify(s, null, 2)], { type: 'application/json' });
        if (dir) await writeToDirectory(dir, stem + '.json', js);
        else downloadBlob(js, stem + '.json');
      }
    }
    toast(`Export abgeschlossen (${targets.length} ${targets.length === 1 ? 'Bild' : 'Bilder'}, ${((performance.now() - t0) / 1000).toFixed(1)} s).`);
  } catch (err) {
    console.error(err);
    toast(`Export fehlgeschlagen: ${err.message}`, true, 6000);
  } finally {
    busy(null);
  }
}

// ---------------------------------------------------------------------------
// Einstellungen als Datei

function saveSettingsFile() {
  const e = active();
  if (!e) return;
  downloadBlob(new Blob([JSON.stringify(e.settings, null, 2)], { type: 'application/json' }), e.name.replace(/\.[^.]+$/, '') + '.filmlab.json');
}

async function loadSettingsFile(file) {
  const e = active();
  if (!e || !file) return;
  try {
    const s = normalizeSettings(JSON.parse(await file.text()));
    e.settings = s;
    e.levelsKey = '';
    commit();
    afterExternalChange();
    toast('Einstellungen geladen.');
  } catch {
    toast('Datei enthält keine gültigen Einstellungen.', true);
  }
}

// ---------------------------------------------------------------------------
// Ereignisse

function initEvents() {
  const fileInput = $('fileInput');
  const open = () => fileInput.click();
  $('btnOpen').addEventListener('click', open);
  $('btnOpen2').addEventListener('click', open);
  $('btnSample').addEventListener('click', loadSample);
  fileInput.addEventListener('change', () => { addFiles(fileInput.files); fileInput.value = ''; });

  $('btnUndo').addEventListener('click', undo);
  $('btnRedo').addEventListener('click', redo);
  $('btnBefore').addEventListener('click', () => { state.before = !state.before; updateButtons(); scheduleRender(); });
  $('btnClip').addEventListener('click', () => { state.clipWarn = !state.clipWarn; updateButtons(); scheduleRender(); });
  $('btnZoom').addEventListener('click', () => toggleZoom());
  $('btnCrop').addEventListener('click', () => active() && setMode(state.mode === 'crop' ? 'edit' : 'crop'));
  $('btnExport').addEventListener('click', openExport);
  $('btnHelp').addEventListener('click', () => $('helpDialog').showModal());
  $('btnCopy').addEventListener('click', copySettings);
  $('btnPaste').addEventListener('click', pasteSettings);
  $('btnSyncAll').addEventListener('click', syncAll);
  $('btnSavePreset').addEventListener('click', savePreset);
  $('presetSelect').addEventListener('change', (e) => { applyPresetValue(e.target.value); e.target.value = ''; });
  $('btnSaveSettings').addEventListener('click', saveSettingsFile);
  $('btnLoadSettings').addEventListener('click', () => $('settingsInput').click());
  $('settingsInput').addEventListener('change', (e) => { loadSettingsFile(e.target.files[0]); e.target.value = ''; });

  $('exFormat').addEventListener('change', updateExportInfo);
  $('exSize').addEventListener('change', updateExportInfo);
  $('exQuality').addEventListener('input', () => { $('exQualityOut').textContent = $('exQuality').value; });
  $('exportDialog').addEventListener('close', () => {
    if ($('exportDialog').returnValue === 'ok') doExport();
  });

  // Drag & Drop
  const body = document.body;
  body.addEventListener('dragover', (e) => { e.preventDefault(); stage.classList.add('drop'); });
  body.addEventListener('dragleave', (e) => { if (!e.relatedTarget) stage.classList.remove('drop'); });
  body.addEventListener('drop', (e) => {
    e.preventDefault();
    stage.classList.remove('drop');
    if (e.dataTransfer.files.length) addFiles(e.dataTransfer.files);
  });

  new ResizeObserver(() => { view.key = ''; scheduleRender(); }).observe(stage);

  window.addEventListener('keydown', (e) => {
    const tag = e.target.tagName;
    const typing = tag === 'INPUT' && e.target.type !== 'range' && e.target.type !== 'checkbox' || tag === 'TEXTAREA' || tag === 'SELECT';
    const mod = e.ctrlKey || e.metaKey;
    if (e.key === 'Escape') {
      if (state.mode !== 'edit') { setMode('edit'); e.preventDefault(); }
      else if (state.zoom) toggleZoom();
      return;
    }
    if (mod && e.key.toLowerCase() === 'o') { e.preventDefault(); open(); return; }
    if (mod && e.key.toLowerCase() === 'e') { e.preventDefault(); openExport(); return; }
    if (typing) return;
    if (mod && e.shiftKey && e.key.toLowerCase() === 'c') { e.preventDefault(); copySettings(); return; }
    if (mod && e.shiftKey && e.key.toLowerCase() === 'v') { e.preventDefault(); pasteSettings(); return; }
    if (mod && (e.key.toLowerCase() === 'y' || (e.shiftKey && e.key.toLowerCase() === 'z'))) { e.preventDefault(); redo(); return; }
    if (mod && e.key.toLowerCase() === 'z') { e.preventDefault(); undo(); return; }
    if (mod || e.altKey) return;
    switch (e.key) {
      case 'b': case 'B': state.before = !state.before; updateButtons(); scheduleRender(); break;
      case '\\': if (!state.holdBefore) { state.holdBefore = true; scheduleRender(); } break;
      case 'j': case 'J': state.clipWarn = !state.clipWarn; updateButtons(); scheduleRender(); break;
      case 'z': case 'Z': toggleZoom(); break;
      case 'c': case 'C': if (active()) setMode(state.mode === 'crop' ? 'edit' : 'crop'); break;
      case 'w': case 'W': if (S()?.film.type !== 'bw') togglePick('pickWB'); break;
      case 'f': case 'F': if (S()?.film.type === 'color') togglePick('pickBase'); break;
      case 'ArrowLeft': if (e.target.type !== 'range') { selectImage(state.active - 1); e.preventDefault(); } break;
      case 'ArrowRight': if (e.target.type !== 'range') { selectImage(state.active + 1); e.preventDefault(); } break;
      case '?': $('helpDialog').showModal(); break;
      default: return;
    }
  });
  window.addEventListener('keyup', (e) => {
    if (e.key === '\\' && state.holdBefore) { state.holdBefore = false; scheduleRender(); }
  });
  window.addEventListener('beforeunload', () => { for (const e of state.images) persist(e); });
}

buildPanel();
buildPresetSelect();
initEvents();
initCrop();
initCanvas();
syncPanel();
updateButtons();

// für Tests und Fehlersuche
window.filmlab = { state, addFiles, selectImage, render, view };
