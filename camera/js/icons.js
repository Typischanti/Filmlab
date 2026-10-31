// Strich-Icons (24×24, currentColor).

const svg = (body) =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;

export const ICONS = {
  date: svg('<rect x="3.5" y="5" width="17" height="15" rx="2.5"/><path d="M3.5 9.5h17M8 3v4M16 3v4"/><path d="M8 14h2M12 14h2M8 17h2" stroke-width="2"/>'),
  frame: svg('<rect x="2.5" y="4" width="19" height="16" rx="1.5"/><rect x="6.5" y="8" width="11" height="8" rx="0.8"/><path d="M5 6h1M9 6h1M13 6h1M17 6h1M5 18h1M9 18h1M13 18h1M17 18h1" stroke-width="2.2"/>'),
  leak: svg('<circle cx="7" cy="8" r="3"/><path d="M7 2.5v1.2M7 12.3v1.2M1.5 8h1.2M11.3 8h1.2M3.1 4.1l.9.9M10 11l.9.9M3.1 11.9l.9-.9M10 5l.9-.9"/><path d="M13 21c1-4 4-7 8.5-8" opacity=".7"/><path d="M9 21c1.5-6 6-10.5 12.5-11.5" opacity=".45"/>'),
  adjust: svg('<path d="M4 7h9M17 7h3M4 17h3M11 17h9"/><circle cx="15" cy="7" r="2.2"/><circle cx="9" cy="17" r="2.2"/>'),
  flip: svg('<path d="M4 12a8 8 0 0 1 13.7-5.6L20 8.5"/><path d="M20 4v4.5h-4.5"/><path d="M20 12a8 8 0 0 1-13.7 5.6L4 15.5"/><path d="M4 20v-4.5h4.5"/>'),
  back: svg('<path d="M15 5l-7 7 7 7"/>'),
  close: svg('<path d="M6 6l12 12M18 6L6 18"/>'),
  share: svg('<path d="M12 3v12M7.5 7.5L12 3l4.5 4.5"/><path d="M7 10.5H5.5a1.5 1.5 0 0 0-1.5 1.5v7.5A1.5 1.5 0 0 0 5.5 21h13a1.5 1.5 0 0 0 1.5-1.5V12a1.5 1.5 0 0 0-1.5-1.5H17"/>'),
  trash: svg('<path d="M4 6.5h16M9.5 6.5V4.5h5v2M6.5 6.5l.9 13a1.5 1.5 0 0 0 1.5 1.4h6.2a1.5 1.5 0 0 0 1.5-1.4l.9-13"/><path d="M10 10.5v6.5M14 10.5v6.5"/>'),
  timer: svg('<circle cx="12" cy="13.5" r="7.5"/><path d="M12 13.5V9.5M9.5 2.5h5M18.5 6.5l1.5-1.5"/>'),
  roll: svg('<rect x="5" y="5" width="11" height="15" rx="2"/><path d="M8 5V3h5v2M16 9h4v8h-4M18 9v8"/>'),
  dice: svg('<rect x="4" y="4" width="16" height="16" rx="3.5"/><circle cx="9" cy="9" r="1.1" fill="currentColor"/><circle cx="15" cy="15" r="1.1" fill="currentColor"/><circle cx="15" cy="9" r="1.1" fill="currentColor"/><circle cx="9" cy="15" r="1.1" fill="currentColor"/>'),
};

export function setIcon(el, name) {
  el.innerHTML = ICONS[name];
}
