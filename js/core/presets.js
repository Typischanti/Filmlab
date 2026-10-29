// Look-Presets. Sie verändern nur den „Look“ (Ton, Farbe, HSL, Grading,
// Kurven, Details) – Filmanalyse, Weißabgleich und Geometrie bleiben erhalten.

import { defaultSettings, cloneSettings, normalizeSettings } from './pipeline.js';

export const LOOK_KEYS = ['tone', 'color', 'hsl', 'grading', 'curves', 'detail'];

export const BUILTIN_PRESETS = [
  { id: 'natural', name: 'Natürlich (Standard)', look: {} },
  {
    id: 'neutral', name: 'Neutral / flach (zum Weiterbearbeiten)',
    look: { tone: { contrast: 0, highlights: 0, shadows: 0 }, color: { vibrance: 0, saturation: 0 } },
  },
  {
    // Nach Laborberichten: flachere Kurve, sanftes Auslaufen in Lichter und
    // Schatten, leicht angehobene neutrale Schatten, kaum Clipping.
    id: 'noritsu', name: 'Laborscan weich (Noritsu-Anmutung)',
    look: {
      tone: { contrast: -8, rolloff: 75, highlights: -15, shadows: 18, blacks: 12 },
      color: { vibrance: 14, saturation: -4 },
      grading: { midtones: { hue: 20, sat: 5 } },
    },
  },
  {
    // Nach Laborberichten: steilere Kurve, tiefe Schatten, Lichter näher an
    // Weiß, goldene Hauttöne und kühlere Schatten, kräftigere Farben.
    id: 'frontier', name: 'Laborscan kräftig (Frontier-Anmutung)',
    look: {
      tone: { contrast: 22, rolloff: 30, highlights: -5, shadows: 0, blacks: -8 },
      color: { vibrance: 30, saturation: 4 },
      grading: { shadows: { hue: 195, sat: 9 }, highlights: { hue: 48, sat: 10 } },
    },
  },
  {
    id: 'vivid', name: 'Kräftig',
    look: { tone: { contrast: 30, highlights: -15, shadows: 5, blacks: -8 }, color: { vibrance: 35, saturation: 5 } },
  },
  {
    id: 'soft', name: 'Weich & hell (Portrait)',
    look: {
      tone: { contrast: -5, highlights: -30, shadows: 25, exposure: 0.15 },
      color: { vibrance: 10, saturation: -5 },
      grading: { highlights: { hue: 45, sat: 10 }, shadows: { hue: 205, sat: 5 } },
    },
  },
  {
    id: 'warm', name: 'Warm & golden (Consumer-Film)',
    look: {
      tone: { contrast: 18, highlights: -12, shadows: 8 },
      color: { vibrance: 28, saturation: 4 },
      grading: { midtones: { hue: 38, sat: 14 }, highlights: { hue: 48, sat: 10 } },
      hsl: { yellow: { h: -4, s: 8, l: 0 } },
    },
  },
  {
    id: 'cool', name: 'Kühl & grün (Fuji-Anmutung)',
    look: {
      tone: { contrast: 15, highlights: -10 },
      color: { vibrance: 18 },
      grading: { shadows: { hue: 170, sat: 12 }, highlights: { hue: 55, sat: 5 } },
      hsl: { green: { h: 10, s: 10, l: 0 }, blue: { h: -5, s: 5, l: 0 } },
    },
  },
  {
    id: 'cine', name: 'Kino (Teal & Orange)',
    look: {
      tone: { contrast: 22, highlights: -20, shadows: 10, blacks: -5 },
      color: { vibrance: 15 },
      grading: { shadows: { hue: 192, sat: 20 }, highlights: { hue: 32, sat: 16 }, balance: 5 },
    },
  },
  {
    id: 'matte', name: 'Matt / verblasst',
    look: {
      tone: { contrast: -10, blacks: 40, whites: -15 },
      color: { vibrance: -10, saturation: -10 },
      grading: { shadows: { hue: 210, sat: 8 } },
    },
  },
  { id: 'bw-classic', name: 'S/W klassisch', look: { tone: { contrast: 20, highlights: -10, shadows: 5 } } },
  { id: 'bw-hard', name: 'S/W hart', look: { tone: { contrast: 50, blacks: -15, whites: 10 } } },
  {
    id: 'bw-selenium', name: 'S/W Selentonung',
    look: { tone: { contrast: 25 }, grading: { shadows: { hue: 285, sat: 14 }, highlights: { hue: 40, sat: 8 } } },
  },
];

// Wendet ein Preset auf Einstellungen an (gibt eine neue Kopie zurück).
export function applyLook(settings, look) {
  const d = defaultSettings();
  const out = cloneSettings(settings);
  const lookOnly = normalizeSettings(Object.fromEntries(LOOK_KEYS.map((k) => [k, look[k] || {}])));
  for (const k of LOOK_KEYS) out[k] = cloneSettings(lookOnly[k] ?? d[k]);
  // Belichtung ist bildabhängig: Presets addieren nur relative Änderungen
  out.tone.exposure = settings.tone.exposure + (look.tone?.exposure || 0);
  return out;
}

export function extractLook(settings) {
  const look = {};
  for (const k of LOOK_KEYS) look[k] = cloneSettings(settings[k]);
  look.tone.exposure = 0;
  return look;
}

const STORE_KEY = 'filmlab:presets';

export function loadUserPresets() {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

export function saveUserPresets(list) {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(list));
    return true;
  } catch {
    return false;
  }
}
