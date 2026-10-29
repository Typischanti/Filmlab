// Farbraum-Hilfsfunktionen (sRGB, Luminanz, Farbton).

export function srgbToLinear(v) {
  return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
}

export function linearToSrgb(v) {
  if (v <= 0) return 0;
  return v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055;
}

// Luminanzgewichte (Rec. 709) – angewendet auf gamma-kodierte Werte,
// was für Sättigungs- und Maskenberechnungen ausreichend genau ist.
export const LUMA_R = 0.2126;
export const LUMA_G = 0.7152;
export const LUMA_B = 0.0722;

export function luma(r, g, b) {
  return LUMA_R * r + LUMA_G * g + LUMA_B * b;
}

// HSV-Farbton in Grad (0..360). Gibt -1 für neutrale Pixel zurück.
export function hueOf(r, g, b) {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const c = max - min;
  if (c <= 1e-6) return -1;
  let h;
  if (max === r) h = ((g - b) / c) % 6;
  else if (max === g) h = (b - r) / c + 2;
  else h = (r - g) / c + 4;
  h *= 60;
  return h < 0 ? h + 360 : h;
}

// Reiner Farbton als RGB-Vektor ohne Grauanteil (Mittelwert 0).
export function hueVector(hueDeg) {
  const h = (((hueDeg % 360) + 360) % 360) / 60;
  const x = 1 - Math.abs((h % 2) - 1);
  let r, g, b;
  if (h < 1) [r, g, b] = [1, x, 0];
  else if (h < 2) [r, g, b] = [x, 1, 0];
  else if (h < 3) [r, g, b] = [0, 1, x];
  else if (h < 4) [r, g, b] = [0, x, 1];
  else if (h < 5) [r, g, b] = [x, 0, 1];
  else [r, g, b] = [1, 0, x];
  const y = luma(r, g, b);
  return [r - y, g - y, b - y];
}

export function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

export function smoothstep(t) {
  t = clamp(t, 0, 1);
  return t * t * (3 - 2 * t);
}
