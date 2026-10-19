// Dock tabs (WAI-ARIA tabs with roving tabindex and arrow keys).

import { state, emit } from './store.js';
import { $, $$, storage, save } from './dom.js';

const KEY = 'firelab.tab';

export function selectTab(name, focus = false) {
  const tabs = $$('.dock-tabs [role="tab"]');
  const tab = tabs.find((t) => t.id === `tab-${name}`) || tabs[0];
  for (const t of tabs) {
    const on = t === tab;
    t.setAttribute('aria-selected', String(on));
    t.tabIndex = on ? 0 : -1;
    $(`#${t.getAttribute('aria-controls')}`).hidden = !on;
  }
  if (focus) tab.focus();
  state.tab = tab.id.slice(4);
  save(KEY, state.tab);
  emit('tab', state.tab);
}

export function initDock() {
  const tabs = $$('.dock-tabs [role="tab"]');
  for (const t of tabs) t.addEventListener('click', () => selectTab(t.id.slice(4)));
  $('.dock-tabs').addEventListener('keydown', (e) => {
    const i = tabs.indexOf(document.activeElement);
    if (i < 0) return;
    let j = null;
    if (e.key === 'ArrowRight') j = (i + 1) % tabs.length;
    else if (e.key === 'ArrowLeft') j = (i - 1 + tabs.length) % tabs.length;
    else if (e.key === 'Home') j = 0;
    else if (e.key === 'End') j = tabs.length - 1;
    if (j == null) return;
    e.preventDefault();
    selectTab(tabs[j].id.slice(4), true);
  });
  // Deep links: #tab=sweep opens a tab directly.
  const fromHash = () => new URLSearchParams(location.hash.slice(1)).get('tab');
  window.addEventListener('hashchange', () => fromHash() && selectTab(fromHash()));
  selectTab(fromHash() || storage(KEY, 'console'));
}
