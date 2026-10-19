import { describe, expect, test } from 'vitest';
import { BrowserDriver, findChrome } from '../src/driver/browser.js';

// A tiny TV page: arrows move a counter, Enter opens a dialog that Back closes; Back at the top is not handled.
const PAGE = `data:text/html,${encodeURIComponent(`<!doctype html><title>t</title><body><div id=o>0</div><script>
let n = 0, dialog = false;
addEventListener('keydown', (e) => {
  if (e.key === 'ArrowRight') n++;
  if (e.key === 'Enter') dialog = true;
  if (e.key === 'Escape' && dialog) { dialog = false; e.preventDefault(); }
  if (e.key === 'ContextMenu') throw new Error('menu bug');
  document.getElementById('o').textContent = n + (dialog ? ' dialog' : '');
});
</script>`)}`;

// Real Chrome: skipped without one, retried under load (Chrome's start-up time varies a lot on a busy machine).
describe.skipIf(!findChrome())('BrowserDriver (real headless Chrome)', { retry: 2 }, () => {
  test('keys, eval, console exceptions, screenshots, and Back leaving the app like the TV wrapper', async () => {
    const d = new BrowserDriver();
    const app = { package: 'web.test', url: PAGE };
    const errors: string[] = [];
    try {
      const { pid } = await d.launch(app);
      expect(pid).toBe(1);
      d.onConsole(app, (e) => e.source === 'exception' && errors.push(e.text));
      expect(await d.foreground()).toEqual({ package: 'web.test' });
      await d.press([{ key: 'right' }, { key: 'right' }, { key: 'ok' }]);
      expect(await d.evaluate('document.getElementById("o").textContent')).toBe('2 dialog');
      await d.press([{ key: 'back' }]);
      expect(await d.evaluate('document.getElementById("o").textContent')).toBe('2');
      expect(await d.foreground()).toEqual({ package: 'web.test' });
      await d.press([{ key: 'menu' }]);
      // The exception event arrives over DevTools a moment later: wait for it (a busy CI box can be slow).
      for (let i = 0; i < 50 && !errors.length; i++) await new Promise((r) => setTimeout(r, 100));
      expect(errors.join('\n')).toMatch(/menu bug/);
      const f = await d.screenshot({ format: 'rgba', width: 64 });
      expect(f.width).toBe(64);
      expect(f.rgba?.length).toBe(64 * 36 * 4);
      expect((await d.screenshot({ width: 480 })).mime).toBe('image/jpeg');
      await d.press([{ key: 'back' }]); // not handled, no history: the app closes
      expect((await d.foreground())?.package).not.toBe('web.test');
      expect(await d.pid(app)).toBeUndefined();
      const again = await d.launch(app);
      expect(again.pid).toBe(2);
      expect(await d.evaluate('document.getElementById("o").textContent')).toBe('0');
    } finally {
      await d.close();
    }
  }, 90_000);
});
