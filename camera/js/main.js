// Filmkamera – App-Logik: Bildschirme, Kamera, Galerie, Entwickeln.

import { FILMS, getFilm } from './films.js';
import {
  ASPECT_LABELS, DEFAULT_SETTINGS, SLIDERS, normalizeSettings, cropRect, dateStampText,
} from './model.js';
import { FilmRenderer } from './gl.js';
import { Camera } from './camera.js';
import * as store from './store.js';
import {
  loadImage, imageToCanvas, canvasToBlob, scaledCanvas, exifDate, developToCanvas,
  photoFileName, shareFiles,
} from './develop.js';
import { ICONS, setIcon } from './icons.js';

const $ = (id) => document.getElementById(id);
const CAM_ASPECTS = ['3:2', '16:9', '2.39'];
const EDIT_ASPECTS = ['orig', '3:2', '16:9', '2.39'];
const PREVIEW_SOURCE_MAX = 2048;

// ---------------------------------------------------------------------------
// Zustand & Speicher

function readJson(key, fallback) {
  try {
    const v = localStorage.getItem(key);
    return v ? JSON.parse(v) : fallback;
  } catch {
    return fallback;
  }
}
function writeJson(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* privat/voll – egal */
  }
}

const state = {
  settings: normalizeSettings(readJson('filmkamera.settings', null)),
  prefs: { quality: 'high', sound: true, motion: true, ...readJson('filmkamera.prefs', {}) },
  screen: 'cam',
  photos: [],
  thumbUrls: new Map(),
  selecting: false,
  selected: new Set(),
  selBlobs: new Map(),
  viewerIndex: -1,
  viewerFile: null,
  edit: null,
  sheetFor: null,
  captures: 0,
};
if (!CAM_ASPECTS.includes(state.settings.aspect)) state.settings.aspect = '3:2';

function saveSettings() {
  const { seed, takenAt, ...rest } = state.settings;
  writeJson('filmkamera.settings', rest);
}
function savePrefs() {
  writeJson('filmkamera.prefs', state.prefs);
}

function randomSeed() {
  return (Math.random() * 0xffffffff) >>> 0;
}

// ---------------------------------------------------------------------------
// Renderer (eine WebGL-Leinwand, die zwischen Kamera und Entwickeln wandert)

const glCanvas = document.createElement('canvas');
let renderer = null;
try {
  renderer = new FilmRenderer(glCanvas);
} catch (err) {
  console.error(err);
}

function mountCanvas(id) {
  const m = $(id);
  if (glCanvas.parentElement !== m) m.appendChild(glCanvas);
}

// ---------------------------------------------------------------------------
// Kleine Helfer

let toastTimer = 0;
function toast(msg, error = false, ms = 2600) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.toggle('error', error);
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), ms);
}

function busy(text) {
  $('busy').hidden = !text;
  if (text) $('busyText').textContent = text;
}

const nextFrame = () => new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));

// Haptik: iOS 18 gibt beim Umschalten eines Schalters eine Rückmeldung.
function haptic() {
  try {
    $('hapticLabel').click();
  } catch {
    /* egal */
  }
}

let audioCtx = null;
function shutterSound() {
  if (!state.prefs.sound) return;
  try {
    audioCtx ??= new (window.AudioContext || window.webkitAudioContext)();
    const ctx = audioCtx;
    if (ctx.state === 'suspended') ctx.resume();
    const click = (t0, gain, freq) => {
      const len = Math.floor(ctx.sampleRate * 0.035);
      const buf = ctx.createBuffer(1, len, ctx.sampleRate);
      const d = buf.getChannelData(0);
      for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 4);
      const src = ctx.createBufferSource();
      src.buffer = buf;
      const bp = ctx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.frequency.value = freq;
      bp.Q.value = 0.8;
      const g = ctx.createGain();
      g.gain.value = gain;
      src.connect(bp).connect(g).connect(ctx.destination);
      src.start(ctx.currentTime + t0);
    };
    click(0, 0.9, 2600);
    click(0.07, 0.6, 1700);
  } catch {
    /* kein Ton */
  }
}

function setPressed(el, on) {
  el.setAttribute('aria-pressed', on ? 'true' : 'false');
}

function fitBox(container, ratio) {
  const r = container.getBoundingClientRect();
  let w = r.width, h = w / ratio;
  if (h > r.height) {
    h = r.height;
    w = h * ratio;
  }
  return { w: Math.max(1, Math.floor(w)), h: Math.max(1, Math.floor(h)) };
}

function dpr() {
  return Math.min(window.devicePixelRatio || 1, 3);
}

// ---------------------------------------------------------------------------
// Filmauswahl

function buildFilmStrip(container, getId, onPick) {
  container.innerHTML = '';
  for (const f of FILMS) {
    const b = document.createElement('button');
    b.className = 'film-card';
    b.dataset.id = f.id;
    b.setAttribute('role', 'radio');
    b.innerHTML = `<div class="film-swatch" style="background:linear-gradient(90deg,${f.swatch.join(',')})"></div>
      <div class="film-name">${f.name}</div><div class="film-meta">${f.group}</div>`;
    b.addEventListener('click', () => {
      onPick(f.id);
      markFilmStrip(container, f.id);
    });
    container.appendChild(b);
  }
  markFilmStrip(container, getId(), false);
}

function markFilmStrip(container, id, smooth = true) {
  for (const b of container.children) {
    const on = b.dataset.id === id;
    b.setAttribute('aria-checked', on ? 'true' : 'false');
    if (on) {
      const left = b.offsetLeft - (container.clientWidth - b.offsetWidth) / 2;
      container.scrollTo({ left, behavior: smooth ? 'smooth' : 'auto' });
    }
  }
}

// ---------------------------------------------------------------------------
// Regler-Blatt (für Kamera und Entwickeln)

function sheetSettings() {
  return state.sheetFor === 'edit' ? state.edit?.settings : state.settings;
}

function onSettingsChanged(target) {
  if (target === 'edit') {
    requestEditRender();
    syncEditToggles();
  } else {
    saveSettings();
    syncCamToggles();
  }
}

function openSheet(target) {
  state.sheetFor = target;
  buildSheet();
  $('sheet').hidden = false;
}

function closeSheet() {
  $('sheet').hidden = true;
  state.sheetFor = null;
}

function buildSheet() {
  const s = sheetSettings();
  if (!s) return;
  const film = getFilm(s.film);
  $('sheetFilm').textContent = `${film.name} · ${film.process}`;
  $('sheetFilmDesc').textContent = film.desc;
  const body = $('sheetBody');
  body.innerHTML = '';
  let group = '';
  for (const def of SLIDERS) {
    if (def.group !== group) {
      group = def.group;
      const h = document.createElement('div');
      h.className = 'sheet-group';
      h.textContent = group;
      body.appendChild(h);
    }
    body.appendChild(makeSlider(def));
  }
  // Schalter
  const sw = document.createElement('div');
  sw.className = 'sheet-switches';
  sw.appendChild(makeSwitch('Datumsstempel', () => sheetSettings().date, (v) => (sheetSettings().date = v)));
  sw.appendChild(makeSwitch('Filmrahmen', () => sheetSettings().frame, (v) => (sheetSettings().frame = v)));
  body.appendChild(sw);

  if (state.sheetFor === 'cam') {
    const h = document.createElement('div');
    h.className = 'sheet-group';
    h.textContent = 'Kamera';
    body.appendChild(h);
    body.appendChild(
      makeSwitch('Hohe Auflösung (bis 12 MP)', () => state.prefs.quality === 'high', (v) => {
        state.prefs.quality = v ? 'high' : 'fast';
        savePrefs();
        camera.quality = state.prefs.quality;
        startCamera();
      }, true),
    );
    body.appendChild(makeSwitch('Auslöseton', () => state.prefs.sound, (v) => { state.prefs.sound = v; savePrefs(); }, true));
    body.appendChild(
      makeSwitch('Querformat erkennen (Lagesensor)', () => state.prefs.motion, (v) => {
        state.prefs.motion = v;
        savePrefs();
        if (v) camera.enableMotion();
        else { camera.deviceRot = 0; applyRotation(0); }
      }, true),
    );
    const info = document.createElement('p');
    info.className = 'fine';
    info.id = 'camInfo';
    info.textContent = camera.width ? `Sensor-Stream: ${camera.width} × ${camera.height} px` : '';
    body.appendChild(info);
  }
}

function makeSlider(def) {
  const wrap = document.createElement('div');
  wrap.className = 'slider';
  const head = document.createElement('div');
  head.className = 'slider-head';
  const name = document.createElement('span');
  name.textContent = def.label;
  const val = document.createElement('span');
  val.className = 'val';
  head.append(name, val);
  const row = document.createElement('div');
  row.className = 'slider-row';
  const input = document.createElement('input');
  input.type = 'range';
  input.min = def.min;
  input.max = def.max;
  input.step = def.step;
  row.appendChild(input);

  const def0 = DEFAULT_SETTINGS[def.key];
  const update = () => {
    const v = sheetSettings()[def.key];
    input.value = v;
    val.textContent = def.fmt(v);
    const pct = ((v - def.min) / (def.max - def.min)) * 100;
    // Regler mit Nullpunkt in der Mitte füllen von der Mitte aus
    const zero = def.min < 0 ? ((0 - def.min) / (def.max - def.min)) * 100 : 0;
    input.style.setProperty('--from', `${Math.min(zero, pct)}%`);
    input.style.setProperty('--fill', `${Math.max(zero, pct)}%`);
    wrap.classList.toggle('changed', Math.abs(v - def0) > 1e-6);
  };
  input.addEventListener('input', () => {
    const s = sheetSettings();
    s[def.key] = Number(input.value);
    if (def.key === 'leak' && s.leak > 0 && !s.leakSeed) s.leakSeed = randomSeed();
    update();
    onSettingsChanged(state.sheetFor);
  });
  // Doppeltippen auf Name oder Wert setzt zurück
  let last = 0;
  head.addEventListener('pointerup', () => {
    const now = performance.now();
    if (now - last < 350) {
      sheetSettings()[def.key] = def0;
      update();
      onSettingsChanged(state.sheetFor);
      haptic();
      last = 0;
    } else last = now;
  });
  if (def.key === 'leak') {
    const dice = document.createElement('button');
    dice.className = 'icon-btn';
    dice.setAttribute('aria-label', 'Neues Lichtleck');
    setIcon(dice, 'dice');
    dice.addEventListener('click', () => {
      const s = sheetSettings();
      s.leakSeed = randomSeed();
      if (!s.leak) s.leak = 0.6;
      update();
      onSettingsChanged(state.sheetFor);
    });
    row.appendChild(dice);
  }
  wrap.append(head, row);
  update();
  return wrap;
}

function makeSwitch(label, get, set, plainPref = false) {
  const row = document.createElement('label');
  row.className = 'switch-row';
  const span = document.createElement('span');
  span.textContent = label;
  const input = document.createElement('input');
  input.type = 'checkbox';
  input.setAttribute('switch', '');
  input.checked = !!get();
  input.addEventListener('change', () => {
    set(input.checked);
    if (!plainPref) onSettingsChanged(state.sheetFor);
  });
  row.append(span, input);
  return row;
}

$('btnSheetClose').addEventListener('click', closeSheet);
$('btnSheetReset').addEventListener('click', () => {
  const s = sheetSettings();
  if (!s) return;
  for (const def of SLIDERS) s[def.key] = DEFAULT_SETTINGS[def.key];
  buildSheet();
  onSettingsChanged(state.sheetFor);
});

// ---------------------------------------------------------------------------
// Kamera

const camera = new Camera($('video'));
camera.quality = state.prefs.quality;
let camRunning = false;
let camStarting = null;
let frameCounter = 0;
let camLayoutKey = '';
let camBox = { w: 1, h: 1 };

async function startCamera() {
  if (!navigator.mediaDevices?.getUserMedia) {
    showCamMsg('Die Kamera ist in diesem Browser nicht verfügbar. Öffne die App über Safari bzw. vom Home-Bildschirm (HTTPS nötig).');
    return;
  }
  if (camStarting) return camStarting;
  camStarting = (async () => {
    try {
      showCamMsg('Kamera wird gestartet …');
      await camera.start();
      camRunning = true;
      $('camMsg').hidden = true;
      camLayoutKey = '';
      renderLenses();
      scheduleCamFrame();
    } catch (err) {
      console.error(err);
      camRunning = false;
      const denied = err?.name === 'NotAllowedError' || err?.name === 'SecurityError';
      showCamMsg(
        denied
          ? 'Kein Zugriff auf die Kamera. Erlaube ihn in der Abfrage oder unter Einstellungen → Safari → Kamera.'
          : `Kamera konnte nicht gestartet werden (${err?.message || err}).`,
        true,
      );
    } finally {
      camStarting = null;
    }
  })();
  return camStarting;
}

function stopCamera() {
  camRunning = false;
  camera.stop();
}

function showCamMsg(text, retry = false) {
  $('camMsg').hidden = false;
  $('camMsgText').textContent = text;
  $('btnCamRetry').hidden = !retry;
}

$('btnCamRetry').addEventListener('click', () => startCamera());

function renderLenses() {
  const box = $('lenses');
  box.innerHTML = '';
  if (camera.facing === 'user') return;
  for (const l of camera.lenses) {
    const b = document.createElement('button');
    b.className = 'lens';
    b.setAttribute('role', 'radio');
    const on = l.zoom === camera.lens;
    b.setAttribute('aria-checked', on ? 'true' : 'false');
    b.textContent = on ? `${String(l.zoom).replace('.', ',')}×` : String(l.zoom).replace('0.5', ',5');
    b.addEventListener('click', async () => {
      if (l.zoom === camera.lens) return;
      haptic();
      try {
        await camera.setLens(l.zoom);
      } catch (err) {
        toast(`Objektiv nicht verfügbar: ${err.message || err}`, true);
      }
      camLayoutKey = '';
      renderLenses();
    });
    box.appendChild(b);
  }
}
camera.onLensesChanged = renderLenses;

function camCrop() {
  return cropRect(camera.width, camera.height, state.settings.aspect);
}

function layoutCam() {
  const crop = camCrop();
  const key = `${crop.w}x${crop.h}|${innerWidth}x${innerHeight}`;
  if (key === camLayoutKey) return;
  camLayoutKey = key;
  camBox = fitBox($('viewfinder'), crop.w / crop.h);
  const f = $('vfFrame');
  f.style.width = `${camBox.w}px`;
  f.style.height = `${camBox.h}px`;
  layoutDateOverlay($('vfDate'), camBox);
}

function layoutDateOverlay(el, box) {
  const short = Math.min(box.w, box.h);
  el.style.fontSize = `${Math.max(8, short * 0.04)}px`;
  el.style.right = `${short * 0.06}px`;
  el.style.bottom = `${short * 0.055}px`;
}

function scheduleCamFrame() {
  const v = camera.video;
  if (v.requestVideoFrameCallback) v.requestVideoFrameCallback(camFrame);
  else requestAnimationFrame(camFrame);
}

function camFrame() {
  if (!camRunning || state.screen !== 'cam' || document.hidden) return;
  if (renderer && camera.width) {
    mountCanvas('glMountCam');
    layoutCam();
    try {
      renderer.setSource(camera.video, camera.width, camera.height);
      const k = dpr();
      renderer.render(state.settings, camCrop(), { w: Math.round(camBox.w * k), h: Math.round(camBox.h * k) }, {
        mirror: camera.mirrored,
        seed: ++frameCounter * 7919,
      });
    } catch (err) {
      console.error(err);
    }
  }
  scheduleCamFrame();
}

function syncCamToggles() {
  const s = state.settings;
  $('btnAspect').textContent = ASPECT_LABELS[s.aspect];
  setPressed($('btnDate'), s.date);
  setPressed($('btnFrame'), s.frame);
  setPressed($('btnLeak'), s.leak > 0);
  $('vfDate').hidden = !s.date;
  $('vfDate').textContent = dateStampText(Date.now());
  $('vfFrameBadge').hidden = !s.frame;
  const ev = $('vfEv');
  ev.hidden = Math.abs(s.ev) < 0.01;
  ev.textContent = `${s.ev > 0 ? '+' : ''}${s.ev.toFixed(1).replace('.', ',')} EV`;
  markFilmStrip($('filmStripCam'), s.film);
  camLayoutKey = '';
}

$('btnAspect').addEventListener('click', () => {
  const s = state.settings;
  s.aspect = CAM_ASPECTS[(CAM_ASPECTS.indexOf(s.aspect) + 1) % CAM_ASPECTS.length];
  saveSettings();
  syncCamToggles();
  haptic();
});
$('btnDate').addEventListener('click', () => toggleSetting(state.settings, 'date', 'cam'));
$('btnFrame').addEventListener('click', () => {
  toggleSetting(state.settings, 'frame', 'cam');
  if (state.settings.frame) toast('Der Filmrahmen wird beim Entwickeln hinzugefügt.');
});
$('btnLeak').addEventListener('click', () => toggleLeak(state.settings, 'cam'));
$('btnAdjust').addEventListener('click', () => (state.sheetFor === 'cam' ? closeSheet() : openSheet('cam')));
$('btnFlip').addEventListener('click', async () => {
  haptic();
  try {
    await camera.flip();
  } catch (err) {
    toast(`Kamera nicht verfügbar: ${err.message || err}`, true);
  }
  camLayoutKey = '';
  renderLenses();
});

function toggleSetting(s, key, target) {
  s[key] = !s[key];
  haptic();
  onSettingsChanged(target);
  if (state.sheetFor === target) buildSheet();
}

function toggleLeak(s, target) {
  if (s.leak > 0) s.leak = 0;
  else {
    s.leak = 0.6;
    s.leakSeed = randomSeed();
  }
  haptic();
  onSettingsChanged(target);
  if (state.sheetFor === target) buildSheet();
}

// Belichtung per senkrechtem Wischen im Sucher
(() => {
  const el = $('vfFrame');
  let start = null;
  el.addEventListener('pointerdown', (e) => {
    start = { y: e.clientY, ev: state.settings.ev, moved: false };
    el.setPointerCapture(e.pointerId);
  });
  el.addEventListener('pointermove', (e) => {
    if (!start) return;
    const dy = start.y - e.clientY;
    if (!start.moved && Math.abs(dy) < 8) return;
    start.moved = true;
    const ev = Math.round(Math.max(-2, Math.min(2, start.ev + dy / 120)) * 10) / 10;
    if (ev !== state.settings.ev) {
      state.settings.ev = ev;
      syncCamToggles();
    }
  });
  const end = () => {
    if (start?.moved) saveSettings();
    start = null;
  };
  el.addEventListener('pointerup', end);
  el.addEventListener('pointercancel', end);
  // Doppeltippen: Belichtung zurücksetzen
  let lastTap = 0;
  el.addEventListener('click', () => {
    const now = performance.now();
    if (now - lastTap < 320 && state.settings.ev !== 0) {
      state.settings.ev = 0;
      saveSettings();
      syncCamToggles();
      haptic();
    }
    lastTap = now;
  });
})();

// Auslösen
$('btnShutter').addEventListener('click', capture);
document.addEventListener('keydown', (e) => {
  if (state.screen === 'cam' && (e.key === ' ' || e.key === 'Enter' || e.key === 'AudioVolumeUp')) {
    e.preventDefault();
    capture();
  }
});

let captureQueue = Promise.resolve();

function capture() {
  if (!camRunning || !camera.width || !renderer) return;
  haptic();
  shutterSound();
  const fl = $('flash');
  fl.classList.remove('on');
  void fl.offsetWidth;
  fl.classList.add('on');

  let src;
  try {
    src = camera.grabFrame();
  } catch (err) {
    toast(`Aufnahme fehlgeschlagen: ${err.message || err}`, true);
    return;
  }
  const settings = { ...state.settings, seed: randomSeed(), takenAt: Date.now() };
  state.captures++;
  updateGalleryButton();
  captureQueue = captureQueue
    .then(async () => {
      const srcBlob = await canvasToBlob(src, 'image/jpeg', 0.92);
      await developAndSave({ id: store.newId(), created: Date.now(), settings, source: 'camera' }, src, srcBlob);
    })
    .catch((err) => {
      console.error(err);
      toast(`Speichern fehlgeschlagen: ${err.message || err}`, true, 5000);
    })
    .finally(() => {
      src.width = src.height = 0;
      state.captures--;
      updateGalleryButton();
    });
}

// Entwickeln (synchron auf der GPU) und in der Galerie speichern.
async function developAndSave(meta, srcCanvas, srcBlob) {
  const settings = meta.settings;
  const frameNo = meta.frameNo ?? (state.photos.length % 36) + 1;
  renderer.setSource(srcCanvas, srcCanvas.width, srcCanvas.height);
  const canvas = developToCanvas(renderer, srcCanvas.width, srcCanvas.height, settings, { frameNo });
  // Vorschau beim Entwickeln wieder auf ihre Quelle setzen
  if (state.screen === 'editor' && state.edit) state.edit.previewDirty = true;
  const out = await canvasToBlob(canvas, 'image/jpeg', 0.93);
  const thumb = await canvasToBlob(scaledCanvas(canvas, 480), 'image/jpeg', 0.82);
  const record = { ...meta, frameNo, w: canvas.width, h: canvas.height, updated: Date.now() };
  canvas.width = canvas.height = 0;
  await store.savePhoto(record, { src: srcBlob, out, thumb });
  await refreshPhotos();
  return record;
}

// ---------------------------------------------------------------------------
// Galerie

async function refreshPhotos() {
  state.photos = await store.listPhotos();
  for (const url of state.thumbUrls.values()) URL.revokeObjectURL(url);
  state.thumbUrls.clear();
  for (const p of state.photos) if (p.thumb) state.thumbUrls.set(p.id, URL.createObjectURL(p.thumb));
  updateGalleryButton();
  if (state.screen === 'gallery') renderGrid();
}

function updateGalleryButton() {
  const img = $('galleryThumb');
  const first = state.photos[0];
  const url = first && state.thumbUrls.get(first.id);
  if (url) img.src = url;
  else img.removeAttribute('src');
  $('galleryBusy').hidden = state.captures <= 0;
}

function renderGrid() {
  const grid = $('grid');
  grid.innerHTML = '';
  grid.classList.toggle('selecting', state.selecting);
  $('galleryEmpty').hidden = state.photos.length > 0;
  state.photos.forEach((p, i) => {
    const cell = document.createElement('button');
    cell.className = 'cell';
    if (state.selected.has(p.id)) cell.classList.add('selected');
    const img = document.createElement('img');
    img.loading = 'lazy';
    img.alt = '';
    const url = state.thumbUrls.get(p.id);
    if (url) img.src = url;
    const tag = document.createElement('span');
    tag.className = 'film-tag';
    tag.textContent = getFilm(p.settings?.film).name;
    const check = document.createElement('span');
    check.className = 'check';
    cell.append(img, tag, check);
    cell.addEventListener('click', () => {
      if (state.selecting) toggleSelect(p.id, cell);
      else openViewer(i);
    });
    grid.appendChild(cell);
  });
  updateSelectBar();
}

function toggleSelect(id, cell) {
  if (state.selected.has(id)) {
    state.selected.delete(id);
    state.selBlobs.delete(id);
  } else {
    state.selected.add(id);
    // Bilder vorab laden: Teilen muss direkt im Tipp passieren
    store.getBlob(id, 'out').then((b) => {
      if (b && state.selected.has(id)) {
        const p = state.photos.find((x) => x.id === id);
        state.selBlobs.set(id, new File([b], photoFileName(p?.settings?.takenAt ?? p?.created ?? Date.now()), { type: 'image/jpeg' }));
        updateSelectBar();
      }
    });
  }
  cell?.classList.toggle('selected', state.selected.has(id));
  updateSelectBar();
}

function updateSelectBar() {
  $('selectBar').hidden = !state.selecting;
  const n = state.selected.size;
  $('selCount').textContent = n === 1 ? '1 ausgewählt' : `${n} ausgewählt`;
  $('btnSelShare').disabled = n === 0 || state.selBlobs.size < n;
  $('btnSelDelete').disabled = n === 0;
  $('btnSelect').textContent = state.selecting ? 'Fertig' : 'Auswählen';
}

function setSelecting(on) {
  state.selecting = on;
  state.selected.clear();
  state.selBlobs.clear();
  renderGrid();
}

$('btnSelect').addEventListener('click', () => setSelecting(!state.selecting));
$('btnSelShare').addEventListener('click', async () => {
  const files = [...state.selected].map((id) => state.selBlobs.get(id)).filter(Boolean);
  if (!files.length) return;
  try {
    const r = await shareFiles(files);
    if (r === 'shared') setSelecting(false);
  } catch (err) {
    toast(`Teilen fehlgeschlagen: ${err.message || err}`, true);
  }
});
$('btnSelDelete').addEventListener('click', async () => {
  const n = state.selected.size;
  if (!n || !confirm(n === 1 ? 'Dieses Foto löschen?' : `${n} Fotos löschen?`)) return;
  await store.deletePhotos([...state.selected]);
  setSelecting(false);
  await refreshPhotos();
  renderGrid();
});

$('btnGallery').addEventListener('click', () => show('gallery'));
$('btnGalleryBack').addEventListener('click', () => show('cam'));

// ---------------------------------------------------------------------------
// Einzelansicht

let viewerUrl = null;

async function openViewer(i) {
  state.viewerIndex = i;
  show('viewer');
  await loadViewer();
}

async function loadViewer() {
  const p = state.photos[state.viewerIndex];
  if (!p) {
    show('gallery');
    return;
  }
  const film = getFilm(p.settings?.film);
  const d = new Date(p.settings?.takenAt ?? p.created);
  $('viewerTitle').innerHTML = `${film.name}<small>${d.toLocaleDateString('de-DE')} · ${d.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' })}</small>`;
  const img = $('viewerImg');
  img.style.opacity = '0.4';
  const thumb = state.thumbUrls.get(p.id);
  if (thumb) img.src = thumb;
  state.viewerFile = null;
  const blob = await store.getBlob(p.id, 'out');
  if (state.photos[state.viewerIndex]?.id !== p.id) return;
  if (viewerUrl) URL.revokeObjectURL(viewerUrl);
  viewerUrl = blob ? URL.createObjectURL(blob) : null;
  if (viewerUrl) img.src = viewerUrl;
  img.style.opacity = '1';
  state.viewerFile = blob ? new File([blob], photoFileName(p.settings?.takenAt ?? p.created), { type: 'image/jpeg' }) : null;
}

$('btnViewerBack').addEventListener('click', () => show('gallery'));
$('btnViewerShare').addEventListener('click', async () => {
  if (!state.viewerFile) return;
  try {
    await shareFiles([state.viewerFile]);
  } catch (err) {
    toast(`Teilen fehlgeschlagen: ${err.message || err}`, true);
  }
});
$('btnViewerDelete').addEventListener('click', async () => {
  const p = state.photos[state.viewerIndex];
  if (!p || !confirm('Dieses Foto löschen?')) return;
  await store.deletePhotos([p.id]);
  await refreshPhotos();
  if (!state.photos.length) show('gallery');
  else {
    state.viewerIndex = Math.min(state.viewerIndex, state.photos.length - 1);
    loadViewer();
  }
});
$('btnViewerEdit').addEventListener('click', () => {
  const p = state.photos[state.viewerIndex];
  if (p) openEditorForPhoto(p);
});

// Wischen zwischen Fotos
(() => {
  const el = $('viewerStage');
  let x0 = null, y0 = 0;
  el.addEventListener('pointerdown', (e) => { x0 = e.clientX; y0 = e.clientY; });
  el.addEventListener('pointerup', (e) => {
    if (x0 == null) return;
    const dx = e.clientX - x0, dy = e.clientY - y0;
    x0 = null;
    if (Math.abs(dx) < 50 || Math.abs(dx) < Math.abs(dy) * 1.5) return;
    const next = state.viewerIndex + (dx < 0 ? 1 : -1);
    if (next >= 0 && next < state.photos.length) {
      state.viewerIndex = next;
      loadViewer();
    }
  });
})();

// ---------------------------------------------------------------------------
// Entwickeln / Bearbeiten

let editRenderPending = false;

async function openEditorForPhoto(p) {
  busy('Lade Original …');
  try {
    const blob = await store.getBlob(p.id, 'src');
    if (!blob) throw new Error('Original nicht gefunden.');
    const img = await loadImage(blob);
    const src = imageToCanvas(img);
    openEditor({ photo: p, settings: normalizeSettings({ ...p.settings }), src, srcBlob: null });
  } catch (err) {
    toast(err.message || String(err), true);
  } finally {
    busy(null);
  }
}

function openEditor(edit) {
  edit.preview = scaledCanvas(edit.src, PREVIEW_SOURCE_MAX);
  edit.previewDirty = true;
  edit.settings.seed ??= randomSeed();
  state.edit = edit;
  show('editor');
  buildFilmStrip($('filmStripEdit'), () => state.edit?.settings.film, (id) => {
    state.edit.settings.film = id;
    haptic();
    onSettingsChanged('edit');
    if (state.sheetFor === 'edit') buildSheet();
  });
  syncEditToggles();
  requestEditRender();
}

function editCrop() {
  const e = state.edit;
  return cropRect(e.preview.width, e.preview.height, e.settings.aspect);
}

function requestEditRender() {
  if (editRenderPending) return;
  editRenderPending = true;
  requestAnimationFrame(() => {
    editRenderPending = false;
    renderEdit();
  });
}

function renderEdit() {
  const e = state.edit;
  if (!e || state.screen !== 'editor' || !renderer) return;
  mountCanvas('glMountEdit');
  const crop = editCrop();
  const box = fitBox($('editStage'), crop.w / crop.h);
  const f = $('editFrame');
  f.style.width = `${box.w}px`;
  f.style.height = `${box.h}px`;
  layoutDateOverlay($('edDate'), box);
  if (e.previewDirty) {
    renderer.setSource(e.preview, e.preview.width, e.preview.height);
    e.previewDirty = false;
  }
  const k = dpr();
  renderer.render(e.settings, crop, { w: Math.round(box.w * k), h: Math.round(box.h * k) }, { seed: e.settings.seed });
}

function syncEditToggles() {
  const s = state.edit?.settings;
  if (!s) return;
  $('btnEdAspect').textContent = ASPECT_LABELS[s.aspect];
  setPressed($('btnEdDate'), s.date);
  setPressed($('btnEdFrame'), s.frame);
  setPressed($('btnEdLeak'), s.leak > 0);
  $('edDate').hidden = !s.date;
  $('edDate').textContent = dateStampText(s.takenAt ?? Date.now());
  markFilmStrip($('filmStripEdit'), s.film);
}

$('btnEdAspect').addEventListener('click', () => {
  const s = state.edit.settings;
  s.aspect = EDIT_ASPECTS[(EDIT_ASPECTS.indexOf(s.aspect) + 1) % EDIT_ASPECTS.length];
  haptic();
  onSettingsChanged('edit');
});
$('btnEdDate').addEventListener('click', () => toggleSetting(state.edit.settings, 'date', 'edit'));
$('btnEdFrame').addEventListener('click', () => {
  toggleSetting(state.edit.settings, 'frame', 'edit');
  if (state.edit.settings.frame) toast('Der Filmrahmen wird beim Entwickeln hinzugefügt.');
});
$('btnEdLeak').addEventListener('click', () => toggleLeak(state.edit.settings, 'edit'));
$('btnEdAdjust').addEventListener('click', () => (state.sheetFor === 'edit' ? closeSheet() : openSheet('edit')));

$('btnEditCancel').addEventListener('click', () => {
  const e = state.edit;
  state.edit = null;
  closeSheet();
  if (e?.photo) show('viewer');
  else show('gallery');
});

$('btnEditDone').addEventListener('click', async () => {
  const e = state.edit;
  if (!e) return;
  closeSheet();
  busy('Entwickle …');
  await nextFrame();
  try {
    const meta = e.photo
      ? { ...e.photo, thumb: undefined, settings: e.settings }
      : { id: store.newId(), created: Date.now(), settings: e.settings, source: 'import' };
    delete meta.thumb;
    const srcBlob = e.photo ? null : e.srcBlob ?? (await canvasToBlob(e.src, 'image/jpeg', 0.92));
    const rec = await developAndSave(meta, e.src, srcBlob);
    state.edit = null;
    state.viewerIndex = Math.max(0, state.photos.findIndex((p) => p.id === rec.id));
    show('viewer');
    loadViewer();
  } catch (err) {
    console.error(err);
    toast(`Entwickeln fehlgeschlagen: ${err.message || err}`, true, 5000);
  } finally {
    busy(null);
  }
});

// ---------------------------------------------------------------------------
// Import aus der Mediathek

$('btnImport').addEventListener('click', () => $('importInput').click());
$('importInput').addEventListener('change', async (ev) => {
  const files = [...ev.target.files];
  ev.target.value = '';
  if (!files.length || !renderer) return;
  const base = { ...state.settings, aspect: 'orig' };
  if (files.length === 1) {
    busy('Lade Foto …');
    try {
      const f = files[0];
      const img = await loadImage(f);
      const src = imageToCanvas(img);
      const takenAt = (await exifDate(f)) ?? Date.now();
      openEditor({ photo: null, settings: normalizeSettings({ ...base, seed: randomSeed(), takenAt }), src, srcBlob: null });
    } catch (err) {
      toast(`Foto konnte nicht geladen werden: ${err.message || err}`, true);
    } finally {
      busy(null);
    }
    return;
  }
  // Mehrere Fotos: direkt mit den aktuellen Einstellungen entwickeln
  let done = 0;
  for (const f of files) {
    busy(`Entwickle ${done + 1} von ${files.length} …`);
    await nextFrame();
    try {
      const img = await loadImage(f);
      const src = imageToCanvas(img);
      const takenAt = (await exifDate(f)) ?? Date.now();
      const settings = normalizeSettings({ ...base, seed: randomSeed(), takenAt });
      const srcBlob = await canvasToBlob(src, 'image/jpeg', 0.92);
      await developAndSave({ id: store.newId(), created: Date.now() + done, settings, source: 'import' }, src, srcBlob);
      src.width = src.height = 0;
      done++;
    } catch (err) {
      console.error(err);
      toast(`${f.name}: ${err.message || err}`, true);
    }
  }
  busy(null);
  toast(`${done} ${done === 1 ? 'Foto' : 'Fotos'} entwickelt.`);
});

// ---------------------------------------------------------------------------
// Bildschirme

function show(name) {
  const prev = state.screen;
  state.screen = name;
  for (const id of ['cam', 'gallery', 'viewer', 'editor']) $(id).classList.toggle('active', id === name);
  if (name !== 'editor' && state.sheetFor === 'edit') closeSheet();
  if (name !== 'cam' && state.sheetFor === 'cam') closeSheet();
  if (name === 'cam') {
    if (!camRunning) startCamera();
    else {
      camLayoutKey = '';
      scheduleCamFrame();
    }
    syncCamToggles();
  } else if (prev === 'cam' || name === 'editor') {
    stopCamera();
  }
  if (name === 'gallery') {
    if (state.selecting) setSelecting(false);
    else renderGrid();
  }
  if (name === 'editor' && state.edit) {
    state.edit.previewDirty = true;
    requestEditRender();
  }
}

// ---------------------------------------------------------------------------
// Drehung der Bedienelemente bei Querformat

const ROTATING = ['btnFlip', 'btnGallery', 'btnDate', 'btnFrame', 'btnLeak', 'btnAdjust', 'btnAspect'];
function applyRotation(r) {
  const ui = screen.orientation?.angle ?? window.orientation ?? 0;
  let rel = (((r - ui) % 360) + 360) % 360;
  if (rel === 270) rel = -90;
  document.documentElement.style.setProperty('--rot', `${rel}deg`);
  for (const id of ROTATING) $(id).classList.add('rotates');
  for (const b of $('lenses').children) b.classList.add('rotates');
}
camera.onRotation = applyRotation;

// ---------------------------------------------------------------------------
// Start

function initIcons() {
  for (const [id, icon] of [
    ['btnDate', 'date'], ['btnFrame', 'frame'], ['btnLeak', 'leak'], ['btnAdjust', 'adjust'], ['btnFlip', 'flip'],
    ['btnGalleryBack', 'back'], ['btnViewerBack', 'back'], ['btnViewerShare', 'share'], ['btnViewerDelete', 'trash'],
    ['btnEdDate', 'date'], ['btnEdFrame', 'frame'], ['btnEdLeak', 'leak'], ['btnEdAdjust', 'adjust'], ['btnSheetClose', 'close'],
  ]) setIcon($(id), icon);
}

function init() {
  initIcons();
  buildFilmStrip($('filmStripCam'), () => state.settings.film, (id) => {
    state.settings.film = id;
    haptic();
    onSettingsChanged('cam');
    if (state.sheetFor === 'cam') buildSheet();
  });
  syncCamToggles();
  if (!renderer) {
    showCamMsg('Dieses Gerät unterstützt WebGL2 nicht – die Filmemulation kann nicht laufen.');
    $('btnShutter').disabled = true;
  } else {
    startCamera();
  }
  refreshPhotos().catch((err) => console.error(err));
  store.requestPersistence();

  // Lagesensor-Erlaubnis bei der ersten Berührung erfragen (iOS-Vorgabe)
  const askMotion = () => {
    if (state.prefs.motion) camera.enableMotion();
    window.removeEventListener('pointerup', askMotion);
  };
  window.addEventListener('pointerup', askMotion);

  window.addEventListener('resize', () => {
    camLayoutKey = '';
    if (state.screen === 'editor') requestEditRender();
    applyRotation(camera.deviceRot);
  });
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) stopCamera();
    else if (state.screen === 'cam') startCamera();
  });

  if ('serviceWorker' in navigator && location.protocol === 'https:') {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
}

init();

// Für Tests
window.__filmkamera = { state, renderer, camera, show };
