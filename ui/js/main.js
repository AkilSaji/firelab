// FireLab dashboard entry point.

import { injectIcons } from './icons.js';
import { initTheme } from './theme.js';
import { initDevices } from './devices.js';
import { initStream } from './stream.js';
import { initScreen } from './screen.js';
import { initRemote } from './remote.js';
import { initPerf } from './perf.js';
import { initConsole } from './console.js';
import { initTimeline } from './timeline.js';
import { initApps } from './apps.js';
import { initSweep } from './sweep.js';
import { initWatch } from './watch.js';
import { initDock } from './dock.js';
import { initPages } from './pages.js';
import { initEngine } from './engine.js';
import { initExec } from './exec.js';
import { initResults } from './results.js';
import { initTestsPage } from './tests-page.js';
import { initLibrary } from './library.js';
import { $, $$, isTyping } from './dom.js';
import { state } from './store.js';

injectIcons();
initTheme();
initDock();
initStream();
initScreen();
initRemote();
initPerf();
initConsole();
initTimeline();
initApps();
initSweep();
initWatch();
initPages();
initEngine();
initExec();
initResults();
initTestsPage();
initLibrary();
initDevices();

// Dialogs: [data-close] buttons and backdrop clicks close them.
for (const dlg of $$('dialog')) {
  dlg.addEventListener('click', (e) => {
    if (e.target === dlg || e.target.closest('[data-close]')) dlg.close();
  });
}

$('#shortcuts-btn').addEventListener('click', () => $('#shortcuts-dialog').showModal());

document.addEventListener('keydown', (e) => {
  if (e.defaultPrevented || isTyping(e.target) || e.metaKey || e.ctrlKey || e.altKey) return;
  if (e.target.closest?.('#screen')) return;
  if (e.key === '?') {
    e.preventDefault();
    $('#shortcuts-dialog').showModal();
  } else if (e.key === 'f' && !document.querySelector('dialog[open]') && state.page === 'devices') {
    // "f" focuses the TV screen so the arrow keys drive the TV.
    e.preventDefault();
    $('#screen').focus();
  }
});
