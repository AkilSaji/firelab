import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { renderFitReport, esc } from '../src/fit/report/html.js';
import { fitOffline } from '../src/fit/offline.js';
import { readMeasurement, emptyMeasurement } from '../src/fit/measurement.js';
import { readApkFacts } from '../src/fit/apk.js';

const sample = readMeasurement(path.join(import.meta.dirname, 'fixtures', 'fit', 'sample-measurement.json'));
const html = renderFitReport(fitOffline(sample));

describe('HTML fit report', () => {
  it('is one self-contained file: inline CSS, no scripts, no external requests', () => {
    expect(html.startsWith('<!doctype html>')).toBe(true);
    expect(html).not.toMatch(/<script/i);
    expect(html).not.toMatch(/<link\b/i);
    expect(html).not.toMatch(/(src|href)\s*=\s*["']?(https?:)?\/\//i);
    expect(html).not.toMatch(/url\(\s*["']?(https?:)?\/\//i);
    expect(html).not.toMatch(/@import/);
    expect(html).toContain('<style>');
  });

  it('uses the dashboard palette in dark and light', () => {
    expect(html).toContain('--accent: #ff7b29');
    expect(html).toContain('--accent: #e0590a');
    expect(html).toContain('@media (prefers-color-scheme: light)');
    expect(html).toContain('--tier-tv-hd: #ff7b29');
  });

  it('has the headline verdict, the focus models, the matrix, runs, media and the disclaimer', () => {
    expect(html).toContain('<title>Fit report: Example three.js game (synthetic)</title>');
    expect(html).toMatch(/<em>Risky<\/em> on the Fire TV Stick \(3rd gen\) and Fire TV Stick Lite \(2020\)/);
    expect(html).toContain('The 1 GB sticks');
    expect(html).toContain('Every Fire OS model');
    expect((html.match(/<tr class="model/g) ?? []).length).toBe(66);
    expect(html).toContain('Not covered: Vega OS');
    expect(html).toContain('measured here');
    expect(html).toContain('sim:AFTSSS');
    expect(html).toContain('finale.mp4');
    expect(html).toContain('The real device is the final word.');
    expect(html).toContain('How fit decides');
    for (const label of ['runs', 'risky', 'won&#39;t run']) expect(html).toContain(`aria-label="${label === 'runs' ? 'ok' : label}"`);
    for (const b of ['b-measured', 'b-profile', 'b-estimated']) expect(html).toContain(b);
  });

  it('escapes everything that came from the app or the device', () => {
    expect(esc('<img src=x onerror="a()">&\'')).toBe('&lt;img src=x onerror=&quot;a()&quot;&gt;&amp;&#39;');
    const evil = renderFitReport(fitOffline({ ...sample, app: { ...sample.app, name: '<script>alert(1)</script>' } }));
    expect(evil).not.toContain('<script>alert(1)</script>');
    expect(evil).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
  });

  it('renders a static-only report with no device', () => {
    const apk = readApkFacts(path.join(import.meta.dirname, 'fixtures', 'fit', 'fixture-tv.apk'));
    const r = renderFitReport(fitOffline(emptyMeasurement({ app: { apk } })));
    expect(r).toContain('No device');
    expect(r).toContain('<em>Runs</em>');
    expect(r).not.toContain('<h2>Runs</h2>');
  });
});
