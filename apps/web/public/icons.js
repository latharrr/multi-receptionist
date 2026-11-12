// Shared by the design prototype pages only: icon sprite + palette preview.
// Icons are authored on a 24px grid, one stroke weight. Use: <svg class="icon"><use href="#i-check"/></svg>
const ICONS = {
  check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
  checks: '<path d="M2.5 12.5l4 4L15 8M11 15.5l1 1L21 8"/>',
  x: '<path d="M6 6l12 12M18 6L6 18"/>',
  alert: '<circle cx="12" cy="12" r="9"/><path d="M12 7.5v5.5M12 16.5v.01"/>',
  idle: '<circle cx="12" cy="12" r="8"/>',
  mock: '<circle cx="12" cy="12" r="8"/><path d="M12 4a8 8 0 0 1 0 16z" fill="currentColor"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  home: '<path d="M4 11l8-7 8 7v8a1 1 0 0 1-1 1h-4v-6H9v6H5a1 1 0 0 1-1-1z"/>',
  inbox: '<path d="M4 13l2.5-8h11L20 13v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1zM4 13h4.5a3.5 3.5 0 0 0 7 0H20"/>',
  list: '<path d="M4 7h9M4 12h9M4 17h6M15.5 16.5l2 2 3.5-4"/>',
  book: '<path d="M5 4h10a3 3 0 0 1 3 3v13H8a3 3 0 0 1-3-3zM5 17a3 3 0 0 1 3-3h10"/>',
  sliders: '<path d="M4 7h10M18 7h2M4 17h2M10 17h10"/><circle cx="16" cy="7" r="2"/><circle cx="8" cy="17" r="2"/>',
  chip: '<rect x="6" y="6" width="12" height="12" rx="2"/><path d="M9 3v3M15 3v3M9 18v3M15 18v3M3 9h3M3 15h3M18 9h3M18 15h3"/>',
  link: '<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/>',
  chart: '<path d="M5 20V10M12 20V4M19 20v-7"/>',
  users: '<circle cx="9" cy="8" r="3.5"/><path d="M3 20a6 6 0 0 1 12 0M16 4.5a3.5 3.5 0 0 1 0 7M21 20a6 6 0 0 0-4-5.6"/>',
  pause: '<path d="M9 5v14M15 5v14"/>',
  send: '<path d="M4 12l16-7-6 16-3-7z"/>',
  down: '<path d="M6 9l6 6 6-6"/>',
  back: '<path d="M14 6l-6 6 6 6"/>',
  right: '<path d="M5 12h14M13 6l6 6-6 6"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5.5M12 7.5v.01"/>',
  more: '<path d="M5 12h.01M12 12h.01M19 12h.01" stroke-width="3"/>',
}
document.body.insertAdjacentHTML(
  'afterbegin',
  `<svg xmlns="http://www.w3.org/2000/svg" aria-hidden="true" style="position:absolute;width:0;height:0">${Object.entries(ICONS)
    .map(([k, v]) => `<symbol id="i-${k}" viewBox="0 0 24 24">${v}</symbol>`)
    .join('')}</svg>`,
)

// Palette preview follows you across the prototype pages. Convenience only; safe to fail.
// Classic script (not a module) so the pages also work when opened straight from disk.
function setPalette(name) {
  document.documentElement.dataset.palette = name
  try { localStorage.setItem('palette', name) } catch {}
}
try { document.documentElement.dataset.palette = localStorage.getItem('palette') || '' } catch {}
