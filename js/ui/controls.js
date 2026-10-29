// Kleine DOM-Helfer für das Einstellungs-Panel.

export function el(tag, attrs = {}, ...children) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') e.className = v;
    else if (k === 'style') e.style.cssText = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else if (k === 'text') e.textContent = v;
    else e.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) {
    if (c == null || c === false) continue;
    e.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return e;
}

export function getPath(obj, path) {
  return path.split('.').reduce((o, k) => (o == null ? o : o[k]), obj);
}

export function setPath(obj, path, value) {
  const keys = path.split('.');
  const last = keys.pop();
  const target = keys.reduce((o, k) => o[k], obj);
  target[last] = value;
}

// Regler mit Zahlenfeld. Doppelklick auf Beschriftung oder Regler setzt zurück.
//   opts: { label, path, min, max, step, unit, digits, track, onInput, onCommit, get, def }
export function slider(opts) {
  const digits = opts.digits ?? (opts.step < 1 ? (opts.step < 0.1 ? 2 : 1) : 0);
  const input = el('input', { type: 'range', min: opts.min, max: opts.max, step: opts.step ?? 1 });
  if (opts.track) input.style.setProperty('--track', opts.track);
  const value = el('input', { class: 'value', type: 'text', inputmode: 'decimal', 'aria-label': opts.label });
  const label = el('label', { title: opts.title || 'Doppelklick: zurücksetzen' }, opts.label);
  const wrap = el('div', { class: 'field' }, label, value, input);

  const fmt = (v) => {
    const s = Number(v).toFixed(digits);
    const signed = opts.min < 0 && v > 0 ? '+' + s : s;
    return opts.unit ? signed + opts.unit : signed;
  };
  const sync = () => {
    const v = opts.get();
    input.value = v;
    if (document.activeElement !== value) value.value = fmt(v);
    wrap.classList.toggle('changed', Math.abs(v - opts.def) > 1e-9);
  };
  const set = (v, commit) => {
    v = Math.min(opts.max, Math.max(opts.min, v));
    opts.onInput(v);
    sync();
    if (commit) opts.onCommit?.();
  };
  input.addEventListener('input', () => set(Number(input.value), false));
  input.addEventListener('change', () => opts.onCommit?.());
  const reset = () => set(opts.def, true);
  label.addEventListener('dblclick', reset);
  input.addEventListener('dblclick', reset);
  value.addEventListener('focus', () => { value.value = Number(opts.get()).toFixed(digits); value.select(); });
  value.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') value.blur();
    if (e.key === 'Escape') { value.value = fmt(opts.get()); value.blur(); }
    if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      e.preventDefault();
      const step = (opts.step ?? 1) * (e.shiftKey ? 10 : 1);
      set(Number(opts.get()) + (e.key === 'ArrowUp' ? step : -step), true);
      value.value = Number(opts.get()).toFixed(digits);
    }
  });
  value.addEventListener('blur', () => {
    const v = parseFloat(value.value.replace(',', '.'));
    if (Number.isFinite(v) && Math.abs(v - opts.get()) > 1e-9) set(v, true);
    value.value = fmt(opts.get());
  });
  // Feinsteuerung mit dem Mausrad bei gedrückter Alt-Taste
  input.addEventListener('wheel', (e) => {
    if (!e.altKey) return;
    e.preventDefault();
    set(Number(opts.get()) - Math.sign(e.deltaY) * (opts.step ?? 1), true);
  }, { passive: false });
  wrap.sync = sync;
  sync();
  return wrap;
}

export function segmented(options, get, onChange) {
  const wrap = el('div', { class: 'segmented', role: 'radiogroup' });
  const buttons = options.map(([value, label, title]) => {
    const b = el('button', { type: 'button', title, role: 'radio' }, label);
    b.addEventListener('click', () => { onChange(value); sync(); });
    wrap.append(b);
    return [value, b];
  });
  const sync = () => {
    const v = get();
    for (const [value, b] of buttons) {
      b.classList.toggle('on', value === v);
      b.setAttribute('aria-checked', value === v);
    }
  };
  wrap.sync = sync;
  sync();
  return wrap;
}

export function select(options, get, onChange, attrs = {}) {
  const s = el('select', attrs, options.map(([v, l]) => el('option', { value: v }, l)));
  s.addEventListener('change', () => onChange(s.value));
  s.sync = () => { s.value = get(); };
  s.sync();
  return s;
}

export function checkbox(label, get, onChange, title) {
  const input = el('input', { type: 'checkbox' });
  input.addEventListener('change', () => onChange(input.checked));
  const wrap = el('label', { class: 'check', title }, input, label);
  wrap.sync = () => { input.checked = !!get(); };
  wrap.sync();
  return wrap;
}

export function section(title, open, body, onReset) {
  const summary = el('summary', {}, title);
  if (onReset) {
    summary.append(el('button', {
      class: 'reset-sec', type: 'button', title: 'Abschnitt zurücksetzen',
      onclick: (e) => { e.preventDefault(); e.stopPropagation(); onReset(); },
    }, 'Zurücksetzen'));
  }
  const d = el('details', { class: 'section' }, summary, el('div', { class: 'section-body' }, body));
  d.open = open;
  return d;
}

export const TRACKS = {
  temp: 'linear-gradient(90deg, #3d6fd6, #8c8c8c, #e0b13a)',
  tint: 'linear-gradient(90deg, #3aa64b, #8c8c8c, #c34fc4)',
  hue: 'linear-gradient(90deg, #f33, #f93, #ff3, #3f3, #3ff, #33f, #f3f, #f33)',
  exposure: 'linear-gradient(90deg, #111, #eee)',
  sat: 'linear-gradient(90deg, #888, #e0603a)',
};

export function bandTrack(kind, hue) {
  if (kind === 'h') return `linear-gradient(90deg, hsl(${hue - 30} 70% 55%), hsl(${hue} 70% 55%), hsl(${hue + 30} 70% 55%))`;
  if (kind === 's') return `linear-gradient(90deg, hsl(${hue} 0% 55%), hsl(${hue} 85% 55%))`;
  return `linear-gradient(90deg, hsl(${hue} 60% 15%), hsl(${hue} 60% 55%), hsl(${hue} 60% 88%))`;
}
