// Theme: dark by default; the toggle switches to light and remembers it.

import { emit } from './store.js';
import { $, storage, save } from './dom.js';

const KEY = 'firelab.theme';

export function effectiveTheme() {
  const t = document.documentElement.dataset.theme;
  if (t === 'light' || t === 'dark') return t;
  return 'dark';
}

function apply(choice) {
  if (choice === 'light') document.documentElement.dataset.theme = choice;
  else delete document.documentElement.dataset.theme;
  const btn = $('#theme-btn');
  if (btn) {
    const now = effectiveTheme();
    const next = now === 'dark' ? 'light' : 'dark';
    btn.setAttribute('aria-label', `Switch to ${next} theme`);
    btn.title = `Switch to ${next} theme`;
    btn.dataset.theme = now;
  }
  emit('theme', effectiveTheme());
}

export function initTheme() {
  apply(storage(KEY, null));
  $('#theme-btn')?.addEventListener('click', () => {
    const next = effectiveTheme() === 'dark' ? 'light' : 'dark';
    save(KEY, next === 'light' ? 'light' : null);
    apply(next);
  });
}

/** Read a CSS custom property from :root. */
export function cssVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

export const reducedMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
