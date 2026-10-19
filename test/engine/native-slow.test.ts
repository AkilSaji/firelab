import { afterEach, describe, expect, test, vi } from 'vitest';
import { NativeFocus, NATIVE_SLOW_DUMP_MS } from '../../src/engine/uidump.js';

const XML = '<?xml version="1.0"?><hierarchy rotation="0"><node index="0" text="Play" resource-id="a:id/play" class="android.widget.Button" package="dev.x" focusable="true" focused="true" bounds="[0,0][100,50]" /></hierarchy>';

describe('native focus gives up on slow dumps', () => {
  afterEach(() => vi.restoreAllMocks());
  test('switches off when the median dump is slower than the limit, and says why', async () => {
    let now = 0;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    const nf = new NativeFocus({ uiDump: async () => ((now += NATIVE_SLOW_DUMP_MS + 2000), XML) }, 'dev.x');
    for (let i = 0; i < 3; i++) await nf.read(`k${i}`);
    expect(nf.off).toBe(true);
    expect(nf.offReason).toMatch(/take about 6\.0 s/);
    expect(await nf.read('k9')).toBeUndefined(); // no more dumps
  });
  test('stays on when dumps are fast', async () => {
    let now = 0;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    const nf = new NativeFocus({ uiDump: async () => ((now += 800), XML) }, 'dev.x');
    for (let i = 0; i < 5; i++) await nf.read(`k${i}`);
    expect(nf.off).toBe(false);
  });
});
