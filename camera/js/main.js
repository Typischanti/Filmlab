// Filmkamera – App-Logik: Bildschirme, Kamera, Galerie, Entwickeln.

import { FILMS, getFilm, filmDisplayName, resolveFilmId } from './films.js';
import {
  ASPECT_LABELS, BORDERS, BORDER_LABELS, DEFAULT_SETTINGS, SLIDERS, normalizeSettings, cropRect, dateStampText,
} from './model.js';
import { FilmRenderer } from './gl.js';
import { Camera } from './camera.js';
import * as store from './store.js';
import {
  loadImage, imageToCanvas, canvasToBlob, scaledCanvas, exifDate, developToCanvas,
  photoFileName, shareFiles, borderLayout, drawBorderPreview, drawDateStamp,
} from './develop.js';
import { VideoRecorder, canRecordVideo, videoExtension } from './recorder.js';
import { ICONS, setIcon } from './icons.js';
import { ensureLut, lutReady, preloadLuts } from './lut.js';

const $ = (id) => document.getElementById(id);
const CAM_ASPECTS = ['3:2', '16:9', '2.39'];
const EDIT_ASPECTS = ['orig', '3:2', '16:9', '2.39'];
const PREVIEW_SOURCE_MAX = 2048;
const ROLL_LENGTH = 36;
const ROLL_MODES = { off: 'Aus', roll: '36 Bilder', lab: 'Mit Entwicklung' };
const BORDER_SHORT = { none: 'Ohne', strip: 'Film', print: 'Abzug', instant: 'Sofort' };
const TIMERS = [0, 3, 10];

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
  prefs: { quality: 'high', sound: true, motion: true, timer: 0, roll: 'off', mode: 'photo', videoAudio: true, ...readJson('filmkamera.prefs', {}) },
  recording: null,
  looks: readJson('filmkamera.looks', []),
  roll: (() => {
    const r = readJson('filmkamera.roll', null); // { id, film, count }
    if (r) r.film = resolveFilmId(r.film);
    return r;
  })(),
  pendingCount: 0,
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

function saveLooks() {
  writeJson('filmkamera.looks', state.looks);
}
function saveRoll() {
  writeJson('filmkamera.roll', state.roll);
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

// Spektrale Filme brauchen ihre LUT; bis sie geladen ist, bleibt das letzte Bild stehen.
function filmReady(settings) {
  const film = getFilm(settings.film);
  if (!renderer || lutReady(film, renderer)) return true;
  ensureLut(film, renderer)
    .then(() => {
      if (state.screen === 'editor') requestEditRender();
    })
    .catch((err) => toast(`Film konnte nicht geladen werden: ${err.message || err}`, true));
  return false;
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
// Filmauswahl und eigene Looks

function targetSettings(target) {
  return target === 'edit' ? state.edit?.settings : state.settings;
}

function stripFor(target) {
  return $(target === 'edit' ? 'filmStripEdit' : 'filmStripCam');
}

const GROUP_LABELS = { Farbnegativ: 'Negativ', Kino: 'Kino', Dia: 'Dia', Schwarzweiß: 'S/W' };

function filmArt(f, iso = true) {
  const [a, b, c] = f.swatch;
  return `<div class="fc-art" style="--a:${a};--b:${b};--c:${c ?? b}">${iso ? `<span class="fc-iso">${f.iso}<small>ISO</small></span><span class="fc-proc">${f.process}</span>` : ''}</div>`;
}

function buildFilmStrip(target) {
  const container = stripFor(target);
  container.innerHTML = '';
  let lastGroup = null;
  for (const f of FILMS) {
    if (f.group !== lastGroup) {
      const label = document.createElement('div');
      label.className = 'strip-label';
      label.textContent = GROUP_LABELS[f.group] ?? f.group;
      container.appendChild(label);
      lastGroup = f.group;
    }
    const b = document.createElement('button');
    b.className = 'film-card';
    b.dataset.id = f.id;
    b.setAttribute('role', 'radio');
    b.setAttribute('aria-label', `${f.name}, ${f.group}`);
    b.innerHTML = `${filmArt(f)}<div class="film-name">${f.name}</div>`;
    b.addEventListener('click', () => pickFilm(target, f.id));
    container.appendChild(b);
  }
  const label = document.createElement('div');
  label.className = 'strip-label';
  label.textContent = 'Looks';
  container.appendChild(label);
  for (const look of state.looks) {
    const f = getFilm(look.settings.film);
    const b = document.createElement('button');
    b.className = 'film-card look';
    b.dataset.look = look.id;
    b.innerHTML = `${filmArt(f, false)}<div class="film-name"></div><div class="film-meta">${f.name}</div>`;
    b.querySelector('.fc-art').insertAdjacentHTML('beforeend', '<span class="fc-iso" style="font-size:15px">★</span>');
    b.querySelector('.film-name').textContent = look.name;
    // Langes Drücken löscht den Look
    let timer = 0, long = false;
    b.addEventListener('pointerdown', () => {
      long = false;
      timer = setTimeout(() => {
        long = true;
        deleteLook(look);
      }, 600);
    });
    for (const ev of ['pointerup', 'pointercancel', 'pointerleave']) b.addEventListener(ev, () => clearTimeout(timer));
    b.addEventListener('click', () => {
      if (!long) applyLook(target, look);
    });
    container.appendChild(b);
  }
  const add = document.createElement('button');
  add.className = 'film-card add';
  add.innerHTML = '<div class="fc-art"><span>+</span></div><div class="film-name">Look sichern</div>';
  add.addEventListener('click', () => saveLook(target));
  container.appendChild(add);
  markFilmStrip(container, targetSettings(target)?.film, false);
  container.classList.toggle('locked', target === 'cam' && rollLocked());
}

function rebuildFilmStrips() {
  buildFilmStrip('cam');
  if (state.edit) buildFilmStrip('edit');
}

function markFilmStrip(container, id, smooth = true) {
  for (const b of container.children) {
    if (!b.dataset.id) continue;
    const on = b.dataset.id === id;
    b.setAttribute('aria-checked', on ? 'true' : 'false');
    if (on) {
      const left = b.offsetLeft - (container.clientWidth - b.offsetWidth) / 2;
      container.scrollTo({ left, behavior: smooth ? 'smooth' : 'auto' });
    }
  }
}

function afterSettingsPick(target) {
  haptic();
  onSettingsChanged(target);
  if (state.sheetFor === target) buildSheet();
  markFilmStrip(stripFor(target), targetSettings(target).film);
}

function pickFilm(target, id) {
  const s = targetSettings(target);
  if (!s) return;
  if (target === 'cam' && rollLocked() && id !== state.roll.film) {
    toast(`Im Film steckt noch eine Rolle ${getFilm(state.roll.film).name} (${state.roll.count}/${ROLL_LENGTH}). Zum Wechseln zurückspulen.`, false, 3600);
    markFilmStrip(stripFor(target), s.film);
    return;
  }
  s.film = id;
  afterSettingsPick(target);
}

function lookSettings(s) {
  const { seed, takenAt, ...rest } = s;
  return rest;
}

function applyLook(target, look) {
  const s = targetSettings(target);
  if (!s) return;
  const keep = { seed: s.seed, takenAt: s.takenAt, aspect: s.aspect };
  Object.assign(s, normalizeSettings({ ...look.settings }), { seed: keep.seed, takenAt: keep.takenAt });
  if (target === 'cam' && !CAM_ASPECTS.includes(s.aspect)) s.aspect = keep.aspect;
  if (target === 'cam' && rollLocked() && s.film !== state.roll.film) {
    s.film = state.roll.film;
    toast('Look übernommen – der Film der eingelegten Rolle bleibt.');
  } else toast(`Look „${look.name}“`);
  afterSettingsPick(target);
}

function saveLook(target) {
  const s = targetSettings(target);
  if (!s) return;
  const name = (prompt('Name für deinen Look:', `${getFilm(s.film).name} – mein Look`) || '').trim();
  if (!name) return;
  state.looks.push({ id: store.newId(), name: name.slice(0, 40), settings: lookSettings(s) });
  saveLooks();
  rebuildFilmStrips();
  toast(`Look „${name}“ gesichert.`);
}

function deleteLook(look) {
  haptic();
  if (!confirm(`Look „${look.name}“ löschen?`)) return;
  state.looks = state.looks.filter((l) => l.id !== look.id);
  saveLooks();
  rebuildFilmStrips();
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

function sheetSection(body, title) {
  const h = document.createElement('div');
  h.className = 'sheet-group';
  h.textContent = title;
  const card = document.createElement('div');
  card.className = 'sheet-card';
  body.append(h, card);
  return card;
}

function buildSheet() {
  const s = sheetSettings();
  if (!s) return;
  const film = getFilm(s.film);
  $('sheetFilm').innerHTML = `<span></span><span class="chip">${film.process}</span>`;
  $('sheetFilm').firstChild.textContent = film.name;
  $('sheetFilmDesc').textContent = film.desc;
  if (film.type === 'lut') {
    const a = document.createElement('a');
    a.href = 'https://github.com/andreavolpato/spektrafilm';
    a.target = '_blank';
    a.rel = 'noopener';
    a.className = 'credit';
    a.textContent = 'Spektral berechnet aus Messdaten von spektrafilm (Andrea Volpato, CC BY-SA 4.0)';
    $('sheetFilmDesc').append(document.createElement('br'), a);
  }
  const body = $('sheetBody');
  body.innerHTML = '';
  let group = '';
  let card = null;
  for (const def of SLIDERS) {
    if (def.group !== group) {
      group = def.group;
      card = sheetSection(body, group);
    }
    card.appendChild(makeSlider(def));
  }
  // Datum und Rahmen gehören zu den Effekten
  card.appendChild(makeSwitch('Datumsstempel', () => sheetSettings().date, (v) => (sheetSettings().date = v)));
  card.appendChild(
    makeSegmented('Rahmen', BORDERS.map((b) => [b, BORDER_SHORT[b]]), () => sheetSettings().border, (v) => {
      sheetSettings().border = v;
      onSettingsChanged(state.sheetFor);
    }),
  );

  if (state.sheetFor === 'cam') {
    const cam = sheetSection(body, 'Aufnahme');
    cam.appendChild(
      makeSegmented('Selbstauslöser', TIMERS.map((t) => [String(t), t ? `${t} s` : 'Aus']), () => String(state.prefs.timer), (v) => {
        state.prefs.timer = Number(v);
        savePrefs();
        syncCamToggles();
      }),
    );
    cam.appendChild(
      makeSegmented('Filmrolle', Object.entries(ROLL_MODES), () => state.prefs.roll, async (v) => {
        const prev = state.prefs.roll;
        state.prefs.roll = v;
        savePrefs();
        if (v === 'off' && state.roll) await finishRoll(prev === 'lab');
        syncCamToggles();
        buildSheet();
      }),
    );
    if (state.prefs.roll !== 'off' && state.roll?.count) {
      const rw = document.createElement('button');
      rw.className = 'btn sheet-action';
      rw.textContent = `Rolle zurückspulen (${state.roll.count}/${ROLL_LENGTH})`;
      rw.addEventListener('click', async () => {
        const lab = state.prefs.roll === 'lab';
        if (!confirm(lab ? 'Rolle jetzt zurückspulen und entwickeln?' : 'Rolle jetzt zurückspulen? Danach kannst du einen anderen Film einlegen.')) return;
        await finishRoll(lab);
        buildSheet();
      });
      cam.appendChild(rw);
    }
    const dev = sheetSection(body, 'Kamera');
    dev.appendChild(
      makeSwitch('Hohe Auflösung (bis 12 MP)', () => state.prefs.quality === 'high', (v) => {
        state.prefs.quality = v ? 'high' : 'fast';
        savePrefs();
        camera.quality = state.prefs.quality;
        startCamera();
      }, true),
    );
    dev.appendChild(makeSwitch('Auslöseton', () => state.prefs.sound, (v) => { state.prefs.sound = v; savePrefs(); }, true));
    dev.appendChild(makeSwitch('Ton bei Videos (Mikrofon)', () => state.prefs.videoAudio, (v) => { state.prefs.videoAudio = v; savePrefs(); }, true));
    dev.appendChild(
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

function makeSegmented(label, options, get, set) {
  const row = document.createElement('div');
  row.className = 'seg-row';
  const span = document.createElement('span');
  span.textContent = label;
  const seg = document.createElement('div');
  seg.className = 'seg';
  seg.setAttribute('role', 'radiogroup');
  seg.setAttribute('aria-label', label);
  const mark = () => {
    for (const b of seg.children) b.setAttribute('aria-checked', b.dataset.value === get() ? 'true' : 'false');
  };
  for (const [value, text] of options) {
    const b = document.createElement('button');
    b.dataset.value = value;
    b.setAttribute('role', 'radio');
    b.textContent = text;
    b.addEventListener('click', () => {
      if (b.dataset.value === get()) return;
      haptic();
      set(value);
      mark();
    });
    seg.appendChild(b);
  }
  mark();
  row.append(span, seg);
  return row;
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
$('sheetGrab').addEventListener('click', closeSheet);
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

// Bild samt Rahmen in den verfügbaren Platz einpassen. Der Rahmen liegt als
// eigene Ebene über dem Live-Bild, der Bildbereich bleibt durchsichtig.
function layoutStage({ container, frame, image, border, cropW, cropH, settings, frameNo }) {
  const L0 = borderLayout(settings.border, cropW, cropH);
  const box = fitBox(container, L0.w / L0.h);
  const k = box.w / L0.w;
  const img = { w: Math.max(1, Math.round(cropW * k)), h: Math.max(1, Math.round(cropH * k)) };
  frame.style.width = `${box.w}px`;
  frame.style.height = `${box.h}px`;
  image.style.left = `${Math.round(L0.ix * k)}px`;
  image.style.top = `${Math.round(L0.iy * k)}px`;
  image.style.width = `${img.w}px`;
  image.style.height = `${img.h}px`;
  const d = dpr();
  // fester Startwert: Staub und Struktur des Rahmens bleiben in der Vorschau ruhig
  img.px = { w: Math.round(img.w * d), h: Math.round(img.h * d) };
  img.L = drawBorderPreview(border, settings.border, img.px.w, img.px.h, { ...settings, seed: 7 }, frameNo);
  return img;
}

function nextFrameNo() {
  if (state.prefs.roll !== 'off') return (state.roll?.count ?? 0) + 1;
  return (state.photos.length % ROLL_LENGTH) + 1;
}

function layoutCam() {
  const crop = camCrop();
  const s = state.settings;
  const frameNo = nextFrameNo();
  const key = `${crop.w}x${crop.h}|${innerWidth}x${innerHeight}|${s.border}|${s.film}|${frameNo}`;
  if (key === camLayoutKey) return;
  camLayoutKey = key;
  camBox = layoutStage({
    container: $('viewfinder'), frame: $('vfFrame'), image: $('vfImage'), border: $('vfBorder'),
    cropW: crop.w, cropH: crop.h, settings: s, frameNo,
  });
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
  if (renderer && camera.width && filmReady(state.settings)) {
    mountCanvas('glMountCam');
    layoutCam();
    try {
      renderer.setSource(camera.video, camera.width, camera.height);
      const k = dpr();
      renderer.render(state.settings, camCrop(), { w: Math.round(camBox.w * k), h: Math.round(camBox.h * k) }, {
        mirror: camera.mirrored,
        seed: ++frameCounter * 7919,
      });
      if (state.recording) composeRecordingFrame();
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
  setPressed($('btnFrame'), s.border !== 'none');
  setPressed($('btnLeak'), s.leak > 0);
  setPressed($('btnTimer'), state.prefs.timer > 0);
  $('btnTimer').querySelector('.badge')?.remove();
  if (state.prefs.timer) {
    const b = document.createElement('span');
    b.className = 'badge';
    b.textContent = state.prefs.timer;
    $('btnTimer').appendChild(b);
  }
  $('vfDate').hidden = !s.date;
  $('vfDate').textContent = dateStampText(Date.now());
  const roll = $('vfRoll');
  roll.hidden = state.prefs.roll === 'off';
  if (!roll.hidden) {
    const film = getFilm(state.roll?.film ?? s.film);
    roll.innerHTML = `${film.name} · <b>${state.roll?.count ?? 0}</b>/${ROLL_LENGTH}`;
  }
  $('filmStripCam').classList.toggle('locked', rollLocked());
  const video = state.prefs.mode === 'video';
  const cur = getFilm(s.film);
  const evTxt = Math.abs(s.ev) >= 0.05 ? ` <i>·</i> <b>${s.ev > 0 ? '+' : ''}${s.ev.toFixed(1).replace('.', ',')} EV</b>` : '';
  $('filmReadout').innerHTML = `<span>${cur.name.toUpperCase()}</span> <i>·</i> <span>ISO ${cur.iso}</span> <i>·</i> <span>${cur.process}</span>${evTxt}`;
  $('modeSwitch').dataset.mode = state.prefs.mode;
  for (const b of $('modeSwitch').children) b.setAttribute('aria-checked', b.dataset.mode === state.prefs.mode ? 'true' : 'false');
  $('modeSwitch').classList.toggle('locked', !!state.recording);
  $('btnShutter').classList.toggle('video', video);
  $('btnShutter').classList.toggle('recording', !!state.recording);
  $('btnShutter').setAttribute('aria-label', video ? (state.recording ? 'Aufnahme beenden' : 'Aufnahme starten') : 'Auslösen');
  $('vfRec').hidden = !state.recording;
  $('btnGallery').disabled = !!state.recording;
  $('btnFlip').disabled = !!state.recording;
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
$('btnFrame').addEventListener('click', () => cycleBorder(state.settings, 'cam'));
for (const b of $('modeSwitch').children) {
  b.addEventListener('click', () => {
    if (state.recording || state.prefs.mode === b.dataset.mode) return;
    if (b.dataset.mode === 'video' && !canRecordVideo()) {
      toast('Videoaufnahme wird von diesem Browser nicht unterstützt.', true);
      return;
    }
    state.prefs.mode = b.dataset.mode;
    savePrefs();
    haptic();
    syncCamToggles();
  });
}
$('btnTimer').addEventListener('click', () => {
  state.prefs.timer = TIMERS[(TIMERS.indexOf(state.prefs.timer) + 1) % TIMERS.length];
  savePrefs();
  haptic();
  syncCamToggles();
  toast(state.prefs.timer ? `Selbstauslöser: ${state.prefs.timer} Sekunden` : 'Selbstauslöser aus');
  if (state.sheetFor === 'cam') buildSheet();
});

function cycleBorder(s, target) {
  s.border = BORDERS[(BORDERS.indexOf(s.border) + 1) % BORDERS.length];
  haptic();
  onSettingsChanged(target);
  if (state.sheetFor === target) buildSheet();
  toast(BORDER_LABELS[s.border]);
}
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
$('btnShutter').addEventListener('click', shutter);
document.addEventListener('keydown', (e) => {
  if (state.screen === 'cam' && (e.key === ' ' || e.key === 'Enter' || e.key === 'AudioVolumeUp')) {
    e.preventDefault();
    shutter();
  }
});

// Selbstauslöser: Countdown im Sucher, erneutes Tippen bricht ab.
let countdown = null;

function shutter() {
  if (countdown) {
    cancelCountdown();
    toast('Selbstauslöser abgebrochen');
    return;
  }
  if (state.prefs.mode === 'video' && state.recording) {
    stopRecording();
    return;
  }
  const fire = () => (state.prefs.mode === 'video' ? startRecording() : capture());
  if (!state.prefs.timer) {
    fire();
    return;
  }
  if (!camRunning) return;
  haptic();
  let n = state.prefs.timer;
  const el = $('vfCount');
  const show = () => {
    el.hidden = false;
    el.textContent = n;
    el.classList.remove('tick');
    void el.offsetWidth;
    el.classList.add('tick');
    beep(n <= 2 ? 1320 : 880);
  };
  $('btnShutter').classList.add('counting');
  show();
  countdown = setInterval(() => {
    n--;
    if (n > 0) show();
    else {
      cancelCountdown();
      fire();
    }
  }, 1000);
}

function cancelCountdown() {
  clearInterval(countdown);
  countdown = null;
  $('vfCount').hidden = true;
  $('btnShutter').classList.remove('counting');
}

function beep(freq) {
  if (!state.prefs.sound) return;
  try {
    audioCtx ??= new (window.AudioContext || window.webkitAudioContext)();
    const o = audioCtx.createOscillator();
    const g = audioCtx.createGain();
    o.frequency.value = freq;
    g.gain.setValueAtTime(0.0001, audioCtx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.15, audioCtx.currentTime + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, audioCtx.currentTime + 0.12);
    o.connect(g).connect(audioCtx.destination);
    o.start();
    o.stop(audioCtx.currentTime + 0.13);
  } catch {
    /* kein Ton */
  }
}

// ---------------------------------------------------------------------------
// Video: Der Sucher samt Rahmen und Datum wird in eine eigene Leinwand
// zusammengesetzt und von dort aufgenommen. Lage (Hoch/Quer) wird beim Start
// festgelegt.

const MAX_VIDEO_SECONDS = 180;

async function startRecording() {
  if (!camRunning || !renderer || state.recording) return;
  if (!canRecordVideo()) {
    toast('Videoaufnahme wird von diesem Browser nicht unterstützt.', true);
    return;
  }
  const geo = camBox?.L ? camBox : null;
  if (!geo) return;
  const L = geo.L;
  const rot = camera.captureRotation();
  const swap = rot === 90 || rot === 270;
  const even = (v) => Math.max(2, Math.round(v / 2) * 2);
  const W = even(L.w), H = even(L.h);
  const canvas = document.createElement('canvas');
  canvas.width = swap ? H : W;
  canvas.height = swap ? W : H;
  const ctx = canvas.getContext('2d');
  // Rahmen und Datum einmal vorbereiten (ändern sich während der Aufnahme nicht)
  const overlay = document.createElement('canvas');
  overlay.width = W;
  overlay.height = H;
  const octx = overlay.getContext('2d');
  if (state.settings.border !== 'none') octx.drawImage($('vfBorder'), 0, 0, W, H);
  if (state.settings.date) drawDateStamp(octx, L.ix, L.iy, geo.px.w, geo.px.h, Date.now());
  const rec = new VideoRecorder();
  state.recording = { rec, canvas, ctx, overlay, rot, W, H, L, px: geo.px, starting: true, settings: { ...state.settings, takenAt: Date.now() } };
  composeRecordingFrame();
  try {
    await rec.start(canvas, { audio: state.prefs.videoAudio });
  } catch (err) {
    state.recording = null;
    toast(`Aufnahme fehlgeschlagen: ${err.message || err}`, true, 5000);
    return;
  }
  if (rec.micDenied) toast('Kein Mikrofonzugriff – Video ohne Ton.');
  state.recording.starting = false;
  haptic();
  beep(1046);
  syncCamToggles();
  const badge = $('vfRec');
  const tick = () => {
    const r = state.recording;
    if (!r) return;
    const t = Math.floor(r.rec.elapsed);
    badge.querySelector('span').textContent = `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`;
    if (t >= MAX_VIDEO_SECONDS) stopRecording();
  };
  tick();
  state.recording.timer = setInterval(tick, 250);
}

function composeRecordingFrame() {
  const r = state.recording;
  if (!r) return;
  const { ctx, canvas, rot, W, H, L, px } = r;
  ctx.save();
  if (rot) {
    ctx.translate(canvas.width / 2, canvas.height / 2);
    ctx.rotate((-rot * Math.PI) / 180);
    ctx.translate(-W / 2, -H / 2);
  }
  if (L.kind === 'none') ctx.drawImage(glCanvas, 0, 0, W, H);
  else {
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, W, H);
    ctx.drawImage(glCanvas, L.ix, L.iy, px.w, px.h);
  }
  ctx.drawImage(r.overlay, 0, 0);
  ctx.restore();
}

async function stopRecording() {
  const r = state.recording;
  if (!r || r.starting || r.stopping) return;
  r.stopping = true;
  clearInterval(r.timer);
  haptic();
  beep(784);
  const thumbCanvas = scaledCanvas(r.canvas, 480);
  let res;
  try {
    res = await r.rec.stop();
  } catch (err) {
    state.recording = null;
    syncCamToggles();
    toast(`Video konnte nicht gespeichert werden: ${err.message || err}`, true, 5000);
    return;
  }
  state.recording = null;
  syncCamToggles();
  if (!res.blob.size) {
    toast('Video ist leer – bitte erneut versuchen.', true);
    return;
  }
  state.captures++;
  updateGalleryButton();
  try {
    const thumb = await canvasToBlob(thumbCanvas, 'image/jpeg', 0.82);
    const meta = {
      id: store.newId(), created: Date.now(), kind: 'video', mime: res.mime, duration: res.duration,
      settings: r.settings, source: 'camera', w: r.canvas.width, h: r.canvas.height,
    };
    await store.savePhoto(meta, { out: res.blob, thumb });
    await refreshPhotos();
    toast(`Video gesichert (${Math.round(res.duration)} s).`);
  } catch (err) {
    console.error(err);
    toast(`Video konnte nicht gespeichert werden: ${err.message || err}`, true, 5000);
  } finally {
    state.captures--;
    updateGalleryButton();
  }
}

function fmtDuration(sec) {
  const t = Math.max(0, Math.round(sec || 0));
  return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`;
}

// Filmrolle: Film ist gesperrt, sobald das erste Bild belichtet ist.
function rollLocked() {
  return state.prefs.roll !== 'off' && (state.roll?.count ?? 0) > 0;
}

// Rolle beenden (voll oder zurückgespult); im Labor-Modus jetzt entwickeln.
async function finishRoll(develop) {
  const roll = state.roll;
  state.roll = null;
  saveRoll();
  if (!roll) return;
  await captureQueue;
  if (develop) {
    const all = await store.listPhotos();
    const ids = all.filter((p) => p.rollId === roll.id && p.pending).map((p) => p.id);
    if (ids.length) {
      busy(`Rolle ${getFilm(roll.film).name} wird entwickelt …`);
      await new Promise((r) => setTimeout(r, 1600));
      await store.updatePhotos(ids, { pending: false });
      await refreshPhotos();
      busy(null);
      toast(`Rolle entwickelt: ${ids.length} ${ids.length === 1 ? 'Bild' : 'Bilder'} in der Galerie.`, false, 3500);
    }
  } else if (roll.count >= ROLL_LENGTH) {
    toast('Rolle voll – neuer Film eingelegt.', false, 3000);
  }
  syncCamToggles();
  rebuildFilmStrips();
}

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
  const meta = { id: store.newId(), created: Date.now(), settings, source: 'camera' };
  let rollFull = false;
  if (state.prefs.roll !== 'off') {
    state.roll ??= { id: store.newId(), film: settings.film, count: 0 };
    state.roll.count++;
    saveRoll();
    meta.rollId = state.roll.id;
    meta.frameNo = state.roll.count;
    meta.pending = state.prefs.roll === 'lab';
    rollFull = state.roll.count >= ROLL_LENGTH;
    syncCamToggles();
    if (state.roll.count === 1) buildFilmStrip('cam');
  }
  state.captures++;
  updateGalleryButton();
  captureQueue = captureQueue
    .then(async () => {
      const srcBlob = await canvasToBlob(src, 'image/jpeg', 0.92);
      await developAndSave(meta, src, srcBlob);
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
  if (rollFull) finishRoll(state.prefs.roll === 'lab');
}

// Entwickeln (synchron auf der GPU) und in der Galerie speichern.
async function developAndSave(meta, srcCanvas, srcBlob) {
  const settings = meta.settings;
  await ensureLut(getFilm(settings.film), renderer);
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
  const all = await store.listPhotos();
  state.photos = all.filter((p) => !p.pending);
  state.pendingCount = all.length - state.photos.length;
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
  const nVid = state.photos.filter((p) => p.kind === 'video').length;
  const nImg = state.photos.length - nVid;
  $('galleryCount').textContent = state.photos.length
    ? [nImg ? `${nImg} ${nImg === 1 ? 'Foto' : 'Fotos'}` : '', nVid ? `${nVid} ${nVid === 1 ? 'Video' : 'Videos'}` : ''].filter(Boolean).join(' · ')
    : '';
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
    tag.textContent = filmDisplayName(p.settings?.film);
    const check = document.createElement('span');
    check.className = 'check';
    cell.append(img, tag, check);
    if (p.kind === 'video') {
      const v = document.createElement('span');
      v.className = 'video-tag';
      v.textContent = `▶ ${fmtDuration(p.duration)}`;
      cell.appendChild(v);
    }
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
        state.selBlobs.set(id, fileForPhoto(p, b));
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

function fileForPhoto(p, blob) {
  const ts = p?.settings?.takenAt ?? p?.created ?? Date.now();
  if (p?.kind === 'video') return new File([blob], photoFileName(ts, 0, videoExtension(p.mime || blob.type)), { type: blob.type || p.mime || 'video/mp4' });
  return new File([blob], photoFileName(ts), { type: 'image/jpeg' });
}

async function loadViewer() {
  const p = state.photos[state.viewerIndex];
  if (!p) {
    show('gallery');
    return;
  }
  const filmName = filmDisplayName(p.settings?.film);
  const d = new Date(p.settings?.takenAt ?? p.created);
  $('viewerTitle').innerHTML = `${filmName}<small>${d.toLocaleDateString('de-DE')} · ${d.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' })}</small>`;
  const img = $('viewerImg');
  const vid = $('viewerVideo');
  const isVideo = p.kind === 'video';
  vid.pause();
  vid.hidden = !isVideo;
  img.hidden = isVideo;
  $('btnViewerEdit').hidden = isVideo;
  img.style.opacity = '0.4';
  const thumb = state.thumbUrls.get(p.id);
  if (thumb) img.src = thumb;
  state.viewerFile = null;
  const blob = await store.getBlob(p.id, 'out');
  if (state.photos[state.viewerIndex]?.id !== p.id) return;
  if (viewerUrl) URL.revokeObjectURL(viewerUrl);
  viewerUrl = blob ? URL.createObjectURL(blob) : null;
  if (viewerUrl) {
    if (isVideo) {
      vid.poster = thumb || '';
      vid.src = viewerUrl;
    } else img.src = viewerUrl;
  }
  img.style.opacity = '1';
  state.viewerFile = blob ? fileForPhoto(p, blob) : null;
}

$('btnViewerBack').addEventListener('click', () => {
  $('viewerVideo').pause();
  show('gallery');
});
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
  edit.layoutKey = '';
  buildFilmStrip('edit');
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
  if (!e || state.screen !== 'editor' || !renderer || !filmReady(e.settings)) return;
  mountCanvas('glMountEdit');
  const crop = editCrop();
  const s = e.settings;
  const frameNo = e.photo?.frameNo ?? nextFrameNo();
  const key = `${crop.w}x${crop.h}|${innerWidth}x${innerHeight}|${s.border}|${s.film}|${frameNo}`;
  if (key !== e.layoutKey) {
    e.layoutKey = key;
    e.box = layoutStage({
      container: $('editStage'), frame: $('editFrame'), image: $('edImage'), border: $('edBorder'),
      cropW: crop.w, cropH: crop.h, settings: s, frameNo,
    });
    layoutDateOverlay($('edDate'), e.box);
  }
  const box = e.box;
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
  setPressed($('btnEdFrame'), s.border !== 'none');
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
$('btnEdFrame').addEventListener('click', () => cycleBorder(state.edit.settings, 'edit'));
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
  if (name !== 'cam' && countdown) cancelCountdown();
  if (name !== 'cam' && state.recording) stopRecording();
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

const ROTATING = ['btnFlip', 'btnGallery', 'btnDate', 'btnFrame', 'btnLeak', 'btnTimer', 'btnAdjust', 'btnAspect'];
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

function setTool(el, icon, label) {
  el.innerHTML = `${ICONS[icon]}<span>${label}</span>`;
}

function initIcons() {
  setTool($('btnViewerShare'), 'share', 'Sichern');
  setTool($('btnViewerEdit'), 'adjust', 'Entwickeln');
  setTool($('btnViewerDelete'), 'trash', 'Löschen');
  setIcon($('emptyIcon'), 'roll');
  for (const [id, icon] of [
    ['btnDate', 'date'], ['btnFrame', 'frame'], ['btnLeak', 'leak'], ['btnTimer', 'timer'], ['btnAdjust', 'adjust'], ['btnFlip', 'flip'],
    ['btnGalleryBack', 'back'], ['btnViewerBack', 'back'],
    ['btnEdDate', 'date'], ['btnEdFrame', 'frame'], ['btnEdLeak', 'leak'], ['btnEdAdjust', 'adjust'], ['btnSheetClose', 'close'],
  ]) setIcon($(id), icon);
}

function init() {
  initIcons();
  if (state.prefs.roll !== 'off' && state.roll?.count) state.settings.film = state.roll.film;
  buildFilmStrip('cam');
  syncCamToggles();
  if (!renderer) {
    showCamMsg('Dieses Gerät unterstützt WebGL2 nicht – die Filmemulation kann nicht laufen.');
    $('btnShutter').disabled = true;
  } else {
    startCamera();
  }
  refreshPhotos().catch((err) => console.error(err));
  if (renderer) setTimeout(() => preloadLuts(renderer), 1500);
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
    if (document.hidden) {
      if (state.recording) stopRecording();
      stopCamera();
    }
    else if (state.screen === 'cam') startCamera();
  });

  if ('serviceWorker' in navigator && location.protocol === 'https:') {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
}

init();

// Für Tests
window.__filmkamera = { state, renderer, camera, show };
