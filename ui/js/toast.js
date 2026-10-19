// Toast notifications (bottom right). Errors stay until dismissed or 8 s.

import { h, icon, $ } from './dom.js';

const ICON = { ok: 'check', error: 'alert', info: 'info', warn: 'alert' };

export function toast(message, { kind = 'info', detail, timeout } = {}) {
  const host = $('#toasts');
  if (!host) return;
  const close = () => {
    el.classList.add('is-leaving');
    setTimeout(() => el.remove(), 180);
  };
  const el = h(
    'div',
    { class: `toast toast--${kind}`, role: kind === 'error' ? 'alert' : 'status' },
    icon(ICON[kind] || 'info', 'toast-icon'),
    h('div', { class: 'toast-body' }, h('div', { class: 'toast-msg', text: message }), detail ? h('div', { class: 'toast-detail', text: detail }) : null),
    h('button', { class: 'toast-x', 'aria-label': 'Dismiss', onclick: close }, icon('x')),
  );
  host.append(el);
  while (host.children.length > 4) host.firstChild.remove();
  setTimeout(close, timeout ?? (kind === 'error' ? 8000 : 3200));
}

export const ok = (msg, detail) => toast(msg, { kind: 'ok', detail });
export const fail = (msg, detail) => toast(msg, { kind: 'error', detail });
export const info = (msg, detail) => toast(msg, { kind: 'info', detail });
