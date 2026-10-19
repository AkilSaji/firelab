// FireLab's icon set: 24px stroke icons drawn for this project, injected once as
// an SVG sprite and used with <svg><use href="#i-name"/></svg>.

const P = {
  tv: '<rect x="2.5" y="4.5" width="19" height="13" rx="2"/><path d="M8 21h8M12 17.5V21"/>',
  radar: '<circle cx="12" cy="12" r="8.5"/><circle cx="12" cy="12" r="4.5"/><path d="M12 12l5.6-5.6"/><circle cx="12" cy="12" r="1.1" fill="currentColor" stroke="none"/>',
  wifi: '<path d="M2.5 9a14 14 0 0 1 19 0M5.5 12.5a9.5 9.5 0 0 1 13 0M8.8 16a4.8 4.8 0 0 1 6.4 0"/><circle cx="12" cy="19.2" r="1.1" fill="currentColor" stroke="none"/>',
  plug: '<path d="M9 2.5v5M15 2.5v5M6.5 7.5h11V11a5.5 5.5 0 0 1-11 0zM12 16.5v5"/>',
  unplug: '<path d="M9 2.5v5M15 2.5v5M6.5 7.5h11V11a5.5 5.5 0 0 1-11 0zM12 16.5v5"/><path d="M3 3l18 18"/>',
  refresh: '<path d="M20 11a8 8 0 1 0-2.3 5.7"/><path d="M20 4.5V11h-6.5"/>',
  camera: '<path d="M3.5 8.5a2 2 0 0 1 2-2h2.2l1.6-2h5.4l1.6 2h2.2a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z"/><circle cx="12" cy="13" r="3.6"/>',
  download: '<path d="M12 3.5v11M7 10l5 5 5-5M4.5 19.5h15"/>',
  play: '<path d="M8 5.5v13l10.5-6.5z" fill="currentColor" stroke-linejoin="round"/>',
  pause: '<rect x="6.5" y="5.5" width="3.8" height="13" rx="1" fill="currentColor" stroke="none"/><rect x="13.7" y="5.5" width="3.8" height="13" rx="1" fill="currentColor" stroke="none"/>',
  stop: '<rect x="6.5" y="6.5" width="11" height="11" rx="1.5" fill="currentColor" stroke="none"/>',
  power: '<path d="M12 3v8"/><path d="M6.6 6.6a7.5 7.5 0 1 0 10.8 0"/>',
  home: '<path d="M3.5 11L12 4l8.5 7"/><path d="M6 9.5V20h12V9.5"/><path d="M10 20v-5h4v5"/>',
  back: '<path d="M9 6.5L4.5 11 9 15.5"/><path d="M5 11h9a5 5 0 0 1 0 10h-2"/>',
  menu: '<path d="M4.5 7h15M4.5 12h15M4.5 17h15"/>',
  search: '<circle cx="10.5" cy="10.5" r="6"/><path d="M15 15l5 5"/>',
  rewind: '<path d="M11.5 6.5L4 12l7.5 5.5zM20 6.5L12.5 12l7.5 5.5z" fill="currentColor" stroke-linejoin="round"/>',
  ff: '<path d="M12.5 6.5L20 12l-7.5 5.5zM4 6.5L11.5 12 4 17.5z" fill="currentColor" stroke-linejoin="round"/>',
  playpause: '<path d="M3.5 6.5v11l8-5.5z" fill="currentColor" stroke-linejoin="round"/><path d="M15 6.5v11M19.5 6.5v11" stroke-width="2.4"/>',
  volup: '<path d="M3.5 9.5H7L11.5 5.5v13L7 14.5H3.5z" fill="currentColor" stroke-linejoin="round"/><path d="M15 12h6M18 9v6"/>',
  voldown: '<path d="M3.5 9.5H7L11.5 5.5v13L7 14.5H3.5z" fill="currentColor" stroke-linejoin="round"/><path d="M15 12h6"/>',
  mute: '<path d="M3.5 9.5H7L11.5 5.5v13L7 14.5H3.5z" fill="currentColor" stroke-linejoin="round"/><path d="M15.5 9.5l5 5M20.5 9.5l-5 5"/>',
  keyboard: '<rect x="2.5" y="6" width="19" height="12" rx="2"/><path d="M6 9.5h.01M9.3 9.5h.01M12.6 9.5h.01M15.9 9.5h.01M18 9.5h.01M7 14.5h10"/>',
  copy: '<rect x="8.5" y="8.5" width="12" height="12" rx="2"/><path d="M15.5 8.5V5.5a2 2 0 0 0-2-2h-8a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h3"/>',
  trash: '<path d="M4.5 6.5h15M9.5 6.5V4h5v2.5M6.5 6.5l1 13.5h9l1-13.5"/>',
  terminal: '<rect x="2.5" y="4" width="19" height="16" rx="2"/><path d="M6.5 9l3 3-3 3M12 15h5"/>',
  remote: '<rect x="7.5" y="2.5" width="9" height="19" rx="4.5"/><circle cx="12" cy="8.5" r="2.4"/><path d="M10.5 14h.01M13.5 14h.01M10.5 17h.01M13.5 17h.01"/>',
  apps: '<rect x="3.5" y="3.5" width="7" height="7" rx="1.5"/><rect x="13.5" y="3.5" width="7" height="7" rx="1.5"/><rect x="3.5" y="13.5" width="7" height="7" rx="1.5"/><rect x="13.5" y="13.5" width="7" height="7" rx="1.5"/>',
  flask: '<path d="M9.5 3.5h5M10.5 3.5V9L5 18.5a1.5 1.5 0 0 0 1.3 2.2h11.4a1.5 1.5 0 0 0 1.3-2.2L13.5 9V3.5"/><path d="M7.4 14.5h9.2"/>',
  eye: '<path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z"/><circle cx="12" cy="12" r="3"/>',
  record: '<circle cx="12" cy="12" r="6" fill="currentColor" stroke="none"/>',
  package: '<path d="M3.5 7.5L12 3l8.5 4.5v9L12 21l-8.5-4.5z"/><path d="M3.5 7.5L12 12l8.5-4.5M12 12v9"/>',
  reset: '<path d="M4 11a8 8 0 1 1 2.3 5.7"/><path d="M4 4.5V11h6.5"/>',
  external: '<path d="M14 4.5h5.5V10M19.5 4.5L11 13M18 14v4.5a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 4 18.5v-11A1.5 1.5 0 0 1 5.5 6H10"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2.5v2M12 19.5v2M4.6 4.6L6 6M18 18l1.4 1.4M2.5 12h2M19.5 12h2M4.6 19.4L6 18M18 6l1.4-1.4"/>',
  moon: '<path d="M20 14.5A8.5 8.5 0 0 1 9.5 4a8.5 8.5 0 1 0 10.5 10.5z"/>',
  alert: '<path d="M12 3.5L2.5 20h19z" stroke-linejoin="round"/><path d="M12 10v4.5M12 17.2v.01"/>',
  check: '<path d="M4.5 12.5l5 5 10-11"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7.5v.01"/>',
  x: '<path d="M6 6l12 12M18 6L6 18"/>',
  chevdown: '<path d="M6 9l6 6 6-6"/>',
  chevright: '<path d="M9 6l6 6-6 6"/>',
  autoscroll: '<path d="M12 4v11M7 10.5l5 5 5-5M5 20h14"/>',
  max: '<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/>',
  chip: '<rect x="6" y="6" width="12" height="12" rx="1.5"/><path d="M9.5 9.5h5v5h-5zM9 2.5V6M15 2.5V6M9 18v3.5M15 18v3.5M2.5 9H6M2.5 15H6M18 9h3.5M18 15h3.5"/>',
  activity: '<path d="M2.5 12h4l2.5-6.5 5 13 2.5-6.5h5"/>',
  enter: '<path d="M19.5 5v7a3 3 0 0 1-3 3H5"/><path d="M9 11l-4 4 4 4"/>',
  help: '<circle cx="12" cy="12" r="9"/><path d="M9.5 9.5a2.5 2.5 0 1 1 3.5 2.3c-.6.3-1 .9-1 1.6v.6M12 17v.01"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3.5 2"/>',
  layers: '<path d="M12 3.5l9 4.5-9 4.5-9-4.5z"/><path d="M3 12.5l9 4.5 9-4.5"/>',
  send: '<path d="M4.5 12L20 4.5 15 20l-3-6.5z" stroke-linejoin="round"/><path d="M12 13.5L20 4.5"/>',
  book: '<path d="M4 5.5A1.5 1.5 0 0 1 5.5 4H11v16H5.5A1.5 1.5 0 0 1 4 18.5zM20 5.5A1.5 1.5 0 0 0 18.5 4H13v16h5.5a1.5 1.5 0 0 0 1.5-1.5z"/>',
  code: '<path d="M8.5 7L3.5 12l5 5M15.5 7l5 5-5 5"/>',
  replay: '<path d="M4 12a8 8 0 1 0 2.3-5.7"/><path d="M4 4.5V10h5.5"/><path d="M10.5 9.3v5.4l4.3-2.7z" fill="currentColor" stroke-linejoin="round"/>',
  gauge: '<path d="M3.5 17.5a8.5 8.5 0 1 1 17 0"/><path d="M12 17.5l4.5-5.5"/><circle cx="12" cy="17.5" r="1.2" fill="currentColor" stroke="none"/>',
  memory: '<rect x="3" y="7" width="18" height="10" rx="1.5"/><path d="M7 7v10M11 7v10M15 7v10M6 17v3M10 17v3M14 17v3M18 17v3"/>',
  scale: '<path d="M4 20V14M4 20h6M20 4v6M20 4h-6M4 20l7-7M20 4l-7 7"/>',
  cpu: '<rect x="5" y="5" width="14" height="14" rx="2"/><path d="M9 2.5V5M15 2.5V5M9 19v2.5M15 19v2.5M2.5 9H5M2.5 15H5M19 9h2.5M19 15h2.5"/><path d="M8.5 15l2-4 2 2.5 2.5-4.5"/>',
  link: '<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1"/><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/>',
  hold: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>',
  temp: '<path d="M10 4.5a2 2 0 0 1 4 0v9.3a4 4 0 1 1-4 0z"/><path d="M12 10v6"/><circle cx="12" cy="17" r="1.2" fill="currentColor" stroke="none"/>',
  updown: '<path d="M8 20V5M4.5 8.5L8 5l3.5 3.5M16 4v15M12.5 15.5L16 19l3.5-3.5"/>',
  list: '<path d="M9 6.5h11M9 12h11M9 17.5h11"/><circle cx="4.8" cy="6.5" r="1.1" fill="currentColor" stroke="none"/><circle cx="4.8" cy="12" r="1.1" fill="currentColor" stroke="none"/><circle cx="4.8" cy="17.5" r="1.1" fill="currentColor" stroke="none"/>',
  rocket: '<path d="M12 15.5l-3.5-3.5c1.6-4.6 4.6-7.6 10.5-8.5-.9 5.9-3.9 8.9-8.5 10.5z"/><path d="M8.5 12H5l2.5-3.5h4M12 15.5V19l3.5-2.5v-4"/><path d="M6.5 17.5l-2 2"/>',
};

export function injectIcons() {
  if (document.getElementById('firelab-icons')) return;
  const symbols = Object.entries(P)
    .map(
      ([name, d]) =>
        `<symbol id="i-${name}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round">${d}</symbol>`,
    )
    .join('');
  const wrap = document.createElement('div');
  wrap.innerHTML = `<svg id="firelab-icons" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" style="position:absolute;width:0;height:0;overflow:hidden">${symbols}</svg>`;
  document.body.prepend(wrap.firstChild);
}

export const ICON_NAMES = Object.keys(P);
