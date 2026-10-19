/**
 * The fit report's stylesheet. The palette and type are copied from the
 * dashboard's ui/css/tokens.css (not imported: the report is one
 * self-contained file with no external requests).
 */
export const REPORT_CSS = `
:root {
  --font-ui: system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
  --font-mono: ui-monospace, "SF Mono", SFMono-Regular, "JetBrains Mono", "Cascadia Mono", Menlo, Consolas, monospace;
  --font-num: "DIN Alternate", "Bahnschrift", "DIN 2014", "D-DIN", system-ui, sans-serif;
  --fs-2xs: 10px; --fs-xs: 11px; --fs-sm: 12px; --fs-md: 13px; --fs-lg: 15px; --fs-xl: 18px;
  --r-xs: 3px; --r-sm: 5px; --r-md: 7px; --r-lg: 10px;
  --tier-low: #8b97a4; --tier-tv: #5b9dff; --tier-tv-hd: #ff7b29; --tier-high: #e2689f;
  color-scheme: dark;
  --bg-0: #08090b; --bg-1: #0e1114; --bg-2: #14181c; --bg-3: #1b2026; --bg-inset: #0a0c0f; --bg-hover: #1a1f25;
  --line-1: #1d2329; --line-2: #29313a; --line-3: #3a444f;
  --ink-1: #eef1f4; --ink-2: #b1bac4; --ink-3: #7d8894; --ink-4: #545e69;
  --accent: #ff7b29; --accent-hi: #ff9550; --accent-ink: #1a0b02; --accent-soft: rgb(255 123 41 / 0.13); --accent-line: rgb(255 123 41 / 0.5);
  --ok: #3ad29c; --ok-soft: rgb(58 210 156 / 0.13);
  --warn: #f2b33d; --warn-soft: rgb(242 179 61 / 0.14);
  --bad: #ff5b4f; --bad-soft: rgb(255 91 79 / 0.14);
  --info: #5fa8ff; --info-soft: rgb(95 168 255 / 0.13);
  --shadow-1: 0 1px 2px rgb(0 0 0 / 0.45);
}
@media (prefers-color-scheme: light) {
  :root:not([data-theme="dark"]) {
    color-scheme: light;
    --bg-0: #e7eaed; --bg-1: #f6f7f8; --bg-2: #ffffff; --bg-3: #eceff2; --bg-inset: #f0f2f4; --bg-hover: #e9edf1;
    --line-1: #dadee3; --line-2: #c9cfd6; --line-3: #aeb6c0;
    --ink-1: #0f1317; --ink-2: #414c57; --ink-3: #66727e; --ink-4: #949eaa;
    --accent: #e0590a; --accent-hi: #c94d06; --accent-ink: #ffffff; --accent-soft: rgb(224 89 10 / 0.1); --accent-line: rgb(224 89 10 / 0.45);
    --ok: #0b9465; --ok-soft: rgb(11 148 101 / 0.1); --warn: #b06f06; --warn-soft: rgb(176 111 6 / 0.11);
    --bad: #d3362b; --bad-soft: rgb(211 54 43 / 0.1); --info: #2a6fd0; --info-soft: rgb(42 111 208 / 0.1);
    --tier-low: #6b7785; --tier-tv: #2a6fd0; --tier-tv-hd: #e0590a; --tier-high: #c4447c;
    --shadow-1: 0 1px 2px rgb(16 24 32 / 0.08);
  }
}
:root[data-theme="light"] {
  color-scheme: light;
  --bg-0: #e7eaed; --bg-1: #f6f7f8; --bg-2: #ffffff; --bg-3: #eceff2; --bg-inset: #f0f2f4; --bg-hover: #e9edf1;
  --line-1: #dadee3; --line-2: #c9cfd6; --line-3: #aeb6c0;
  --ink-1: #0f1317; --ink-2: #414c57; --ink-3: #66727e; --ink-4: #949eaa;
  --accent: #e0590a; --accent-hi: #c94d06; --accent-ink: #ffffff; --accent-soft: rgb(224 89 10 / 0.1); --accent-line: rgb(224 89 10 / 0.45);
  --ok: #0b9465; --ok-soft: rgb(11 148 101 / 0.1); --warn: #b06f06; --warn-soft: rgb(176 111 6 / 0.11);
  --bad: #d3362b; --bad-soft: rgb(211 54 43 / 0.1); --info: #2a6fd0; --info-soft: rgb(42 111 208 / 0.1);
  --tier-low: #6b7785; --tier-tv: #2a6fd0; --tier-tv-hd: #e0590a; --tier-high: #c4447c;
}
*, *::before, *::after { box-sizing: border-box; }
html { -webkit-text-size-adjust: 100%; }
body { margin: 0; background: var(--bg-0); color: var(--ink-1); font: 400 var(--fs-md) / 1.5 var(--font-ui); -webkit-font-smoothing: antialiased; }
h1, h2, h3, p, ul { margin: 0; }
ul { padding: 0; list-style: none; }
code { font-family: var(--font-mono); font-size: 0.92em; padding: 0.05em 0.35em; border-radius: var(--r-xs); background: var(--bg-3); }
a { color: var(--accent); }
.wrap { max-width: 1240px; margin: 0 auto; padding: 0 24px 48px; }

/* top bar */
.top { display: flex; align-items: center; gap: 14px; height: 56px; padding: 0 24px; border-bottom: 1px solid var(--line-1); background: var(--bg-1); }
.brand { display: flex; align-items: center; gap: 9px; font: 650 var(--fs-lg) / 1 var(--font-ui); letter-spacing: -0.01em; }
.brand svg { width: 26px; height: 26px; }
.brand b { color: var(--accent); font-weight: 650; }
.top .sep { width: 1px; height: 22px; background: var(--line-2); }
.top .doc { font: 600 var(--fs-2xs) / 1 var(--font-mono); letter-spacing: 0.12em; text-transform: uppercase; color: var(--ink-3); }
.top .app { font-weight: 600; font-size: var(--fs-lg); min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.top .meta { margin-left: auto; font: 500 var(--fs-xs) / 1 var(--font-mono); color: var(--ink-3); white-space: nowrap; }

.label { font: 600 var(--fs-2xs) / 1 var(--font-mono); letter-spacing: 0.1em; text-transform: uppercase; color: var(--ink-3); }
.mono { font-family: var(--font-mono); }
.num { font-family: var(--font-num); font-variant-numeric: tabular-nums; }
.muted { color: var(--ink-3); }

/* hero */
.hero { display: grid; grid-template-columns: minmax(0, 1.55fr) minmax(0, 1fr); gap: 16px; margin-top: 22px; }
.hero > *, .focus > * { min-width: 0; }
.card { background: var(--bg-2); border: 1px solid var(--line-1); border-radius: var(--r-lg); box-shadow: var(--shadow-1); }
.verdict-card { position: relative; display: flex; gap: 18px; padding: 22px 22px 20px; overflow: hidden; }
.verdict-card::before { content: ""; position: absolute; inset: 0 auto 0 0; width: 4px; background: var(--c); }
.verdict-card.v-runs { --c: var(--ok); --s: var(--ok-soft); }
.verdict-card.v-risky { --c: var(--warn); --s: var(--warn-soft); }
.verdict-card.v-wont-run { --c: var(--bad); --s: var(--bad-soft); }
.verdict-card.v-not-covered { --c: var(--ink-3); --s: var(--bg-3); }
.big-mark { flex: none; display: grid; place-items: center; width: 64px; height: 64px; border-radius: 14px; background: var(--s); color: var(--c); border: 1px solid color-mix(in srgb, var(--c) 45%, transparent); }
.big-mark svg { width: 34px; height: 34px; }
.verdict-card h1 { font-size: 22px; line-height: 1.25; font-weight: 650; letter-spacing: -0.01em; }
.verdict-card h1 em { font-style: normal; color: var(--c); }
.verdict-card .why { margin-top: 6px; color: var(--ink-2); }
.verdict-card .overall { margin-top: 12px; color: var(--ink-2); font-size: var(--fs-sm); }
.tiles { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 0; margin-top: 16px; border-top: 1px solid var(--line-1); }
.tile { padding: 12px 0 0; }
.tile + .tile { padding-left: 16px; border-left: 1px solid var(--line-1); }
.tile .n { display: block; margin-top: 6px; font: 600 28px / 1 var(--font-num); font-variant-numeric: tabular-nums; }
.tile.t-runs .n { color: var(--ok); } .tile.t-risky .n { color: var(--warn); } .tile.t-wont-run .n { color: var(--bad); } .tile.t-not-covered .n { color: var(--ink-3); }

.device-card { padding: 18px 20px; display: flex; flex-direction: column; gap: 12px; }
.device-card h2 { font-size: var(--fs-lg); font-weight: 600; margin-top: 6px; }
.kv { display: grid; grid-template-columns: auto 1fr; gap: 6px 14px; font-size: var(--fs-sm); }
.kv dt { color: var(--ink-3); font: 600 var(--fs-2xs) / 1.9 var(--font-mono); letter-spacing: 0.08em; text-transform: uppercase; }
.kv dd { margin: 0; color: var(--ink-1); font-family: var(--font-mono); font-size: var(--fs-xs); line-height: 1.9; overflow-wrap: anywhere; }
.chips { display: flex; flex-wrap: wrap; gap: 6px; }
.chip { display: inline-flex; align-items: center; gap: 5px; height: 20px; padding: 0 7px; border: 1px solid var(--line-2); border-radius: var(--r-xs); font: 650 var(--fs-2xs) / 1 var(--font-mono); letter-spacing: 0.06em; text-transform: uppercase; color: var(--ink-2); white-space: nowrap; }
.chip.on { border-color: var(--accent-line); background: var(--accent-soft); color: var(--ink-1); }
.chip.off { color: var(--ink-4); border-style: dashed; }
.tier { --c: var(--tier-tv); display: inline-flex; align-items: center; gap: 5px; height: 18px; padding: 0 6px; border: 1px solid color-mix(in srgb, var(--c) 55%, transparent); border-radius: var(--r-xs); background: color-mix(in srgb, var(--c) 12%, transparent); color: var(--ink-1); font: 650 var(--fs-2xs) / 1 var(--font-mono); letter-spacing: 0.06em; text-transform: uppercase; white-space: nowrap; }
.tier::before { content: ""; width: 6px; height: 6px; border-radius: 1px; background: var(--c); }
.tier--low { --c: var(--tier-low); } .tier--tv { --c: var(--tier-tv); } .tier--tv-hd { --c: var(--tier-tv-hd); } .tier--high { --c: var(--tier-high); }

/* sections */
section { margin-top: 30px; }
.section-head { display: flex; flex-wrap: wrap; align-items: baseline; gap: 4px 12px; margin-bottom: 12px; }
.section-head h2 { font-size: var(--fs-lg); font-weight: 650; }
.section-head .hint { color: var(--ink-3); font-size: var(--fs-sm); }

/* focus cards */
.focus { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(340px, 100%), 1fr)); gap: 14px; }
.focus .card { padding: 16px 18px; }
.focus h3 { display: flex; align-items: center; gap: 8px; font-size: var(--fs-lg); font-weight: 600; }
.focus .sub { margin-top: 3px; color: var(--ink-3); font: 500 var(--fs-xs) / 1.4 var(--font-mono); }
.focus .checks { margin-top: 12px; display: grid; gap: 8px; }
.focus .checks li { display: grid; grid-template-columns: 18px minmax(0, 1fr); gap: 8px; font-size: var(--fs-sm); color: var(--ink-2); overflow-wrap: anywhere; }
.focus .checks b { color: var(--ink-1); font-weight: 600; }
.fix { margin-top: 12px; padding: 10px 12px; border-radius: var(--r-md); background: var(--bg-inset); border: 1px solid var(--line-1); font-size: var(--fs-sm); color: var(--ink-2); }
.fix .label { display: block; margin-bottom: 5px; color: var(--accent); }
.fix li { position: relative; padding-left: 12px; overflow-wrap: anywhere; }
.fix li + li { margin-top: 5px; }
.fix li::before { content: ""; position: absolute; left: 0; top: 0.62em; width: 5px; height: 5px; border-radius: 1px; background: var(--accent); }
.passed { display: flex; gap: 8px; overflow-wrap: anywhere; margin-top: 10px; padding-top: 10px; border-top: 1px dashed var(--line-2); font-size: var(--fs-sm); color: var(--ink-2); }

/* status marks */
.st { display: inline-grid; place-items: center; width: 16px; height: 16px; flex: none; border-radius: 4px; }
.st svg { width: 12px; height: 12px; }
.st-pass { color: var(--ok); background: var(--ok-soft); }
.st-warn { color: var(--warn); background: var(--warn-soft); }
.st-fail { color: var(--bad); background: var(--bad-soft); }
.st-skip, .st-not-covered { color: var(--ink-4); background: var(--bg-3); }
.verdict { display: inline-flex; align-items: center; gap: 6px; font: 650 var(--fs-2xs) / 1 var(--font-mono); letter-spacing: 0.08em; text-transform: uppercase; white-space: nowrap; }
.verdict.v-runs { color: var(--ok); } .verdict.v-risky { color: var(--warn); } .verdict.v-wont-run { color: var(--bad); } .verdict.v-not-covered { color: var(--ink-3); }

/* matrix */
.legend { display: flex; flex-wrap: wrap; gap: 14px; margin: -2px 0 12px; color: var(--ink-3); font-size: var(--fs-xs); }
.legend span { display: inline-flex; align-items: center; gap: 6px; }
.matrix-wrap { overflow-x: auto; border: 1px solid var(--line-1); border-radius: var(--r-lg); background: var(--bg-2); }
table { width: 100%; border-collapse: collapse; }
.matrix th { position: sticky; top: 0; z-index: 1; padding: 10px 10px; background: var(--bg-1); border-bottom: 1px solid var(--line-2); text-align: left; font: 600 var(--fs-2xs) / 1 var(--font-mono); letter-spacing: 0.1em; text-transform: uppercase; color: var(--ink-3); white-space: nowrap; }
.matrix td { padding: 9px 10px; border-bottom: 1px solid var(--line-1); vertical-align: top; }
.matrix tbody.group th { position: static; padding: 14px 10px 8px; background: var(--bg-2); border-bottom: 1px solid var(--line-1); color: var(--ink-2); }
.matrix tr.model:hover td { background: var(--bg-hover); }
.matrix tr.here td:first-child { box-shadow: inset 3px 0 0 var(--accent); }
.mname { font-weight: 600; }
.mmeta { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 6px; margin-top: 4px; color: var(--ink-3); font: 500 var(--fs-2xs) / 1.3 var(--font-mono); }
.cell { display: flex; align-items: flex-start; gap: 6px; min-width: 84px; max-width: 150px; font: 500 var(--fs-xs) / 16px var(--font-mono); color: var(--ink-2); }
.cell.none { color: var(--ink-4); }
.cell small { display: block; color: var(--ink-4); font-size: var(--fs-2xs); }
.badge { display: inline-flex; align-items: center; height: 18px; padding: 0 6px; border-radius: var(--r-xs); font: 650 var(--fs-2xs) / 1 var(--font-mono); letter-spacing: 0.06em; text-transform: uppercase; white-space: nowrap; border: 1px solid var(--line-2); color: var(--ink-3); }
.badge.b-measured { color: var(--ok); border-color: color-mix(in srgb, var(--ok) 45%, transparent); background: var(--ok-soft); }
.badge.b-profile { color: var(--info); border-color: color-mix(in srgb, var(--info) 45%, transparent); background: var(--info-soft); }
.badge.b-here { color: var(--accent); border-color: var(--accent-line); background: var(--accent-soft); }
.conf { display: inline-flex; align-items: center; gap: 3px; font: 600 var(--fs-2xs) / 1 var(--font-mono); letter-spacing: 0.06em; text-transform: uppercase; color: var(--ink-3); white-space: nowrap; }
.conf i { width: 6px; height: 6px; border-radius: 50%; background: var(--line-3); }
.conf i.on { background: var(--ink-2); }
.conf span { margin-left: 4px; }
tr.why td { padding: 0 10px 12px 10px; border-bottom: 1px solid var(--line-1); }
tr.why details > summary { cursor: pointer; width: max-content; color: var(--ink-3); font: 600 var(--fs-2xs) / 1.6 var(--font-mono); letter-spacing: 0.08em; text-transform: uppercase; }
tr.why details[open] > summary { margin-bottom: 6px; }
.matrix td:first-child { min-width: 210px; }
tr.model.has-why td { border-bottom: 0; }
.why-box { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 0.8fr); gap: 14px; padding: 10px 12px; border-radius: var(--r-md); background: var(--bg-inset); border: 1px solid var(--line-1); font-size: var(--fs-sm); color: var(--ink-2); }
.why-box li { display: grid; grid-template-columns: 16px 1fr; gap: 8px; }
.why-box li + li { margin-top: 6px; }
.why-box .fixes li { grid-template-columns: 1fr; }
.why-box .label { display: block; margin-bottom: 6px; }
.why-box .fixes .label { color: var(--accent); }

/* runs and media */
.data th { padding: 9px 12px; text-align: left; border-bottom: 1px solid var(--line-2); font: 600 var(--fs-2xs) / 1 var(--font-mono); letter-spacing: 0.1em; text-transform: uppercase; color: var(--ink-3); background: var(--bg-1); white-space: nowrap; }
.data td { padding: 9px 12px; border-bottom: 1px solid var(--line-1); font: 500 var(--fs-xs) / 1.45 var(--font-mono); color: var(--ink-2); vertical-align: top; }
.data td.r, .data th.r { text-align: right; }
.data tr:last-child td { border-bottom: 0; }
.media-list { display: grid; gap: 12px; }
.media-item { padding: 14px 16px; }
.media-item h3 { display: flex; align-items: center; gap: 8px; font: 600 var(--fs-md) / 1.3 var(--font-mono); overflow-wrap: anywhere; }
.media-item .desc { margin-top: 4px; color: var(--ink-3); font: 500 var(--fs-xs) / 1.4 var(--font-mono); }
.media-item ul { margin-top: 10px; display: grid; gap: 8px; }
.media-item li { display: grid; grid-template-columns: 16px minmax(0, 1fr); gap: 8px; font-size: var(--fs-sm); color: var(--ink-2); overflow-wrap: anywhere; }
.media-item .models { color: var(--ink-3); font: 500 var(--fs-2xs) / 1.6 var(--font-mono); }
.media-item .mfix { color: var(--ink-3); font-size: var(--fs-xs); }
.media-item .mfix b { color: var(--accent); font-weight: 600; }

details.method { margin-top: 30px; }
details.method summary { cursor: pointer; font-weight: 650; font-size: var(--fs-lg); }
details.method .card { margin-top: 12px; padding: 16px 18px; color: var(--ink-2); font-size: var(--fs-sm); }
details.method p + p { margin-top: 8px; }
.notes { margin-top: 10px; display: grid; gap: 6px; color: var(--ink-2); font-size: var(--fs-sm); }
.notes li::before { content: "– "; color: var(--ink-4); }
.disclaimer { margin-top: 30px; padding: 14px 16px; border-radius: var(--r-lg); border: 1px solid var(--accent-line); background: var(--accent-soft); color: var(--ink-1); font-size: var(--fs-sm); }
.disclaimer b { color: var(--accent); }
footer { margin-top: 26px; color: var(--ink-4); font: 500 var(--fs-xs) / 1.5 var(--font-mono); }

@media (max-width: 900px) {
  .hero { grid-template-columns: minmax(0, 1fr); }
  .verdict-card { flex-direction: column; gap: 12px; padding: 18px 16px 16px; }
  .big-mark { width: 48px; height: 48px; }
  .verdict-card h1 { font-size: 19px; }
  .why-box { grid-template-columns: 1fr; }
  .wrap { padding: 0 16px 40px; }
  .top { padding: 0 16px; }
  .top .meta { display: none; }
  .tiles { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .tile:nth-child(3) { padding-left: 0; border-left: 0; }
}
@media print {
  :root { color-scheme: light; --bg-0: #fff; --bg-1: #f6f7f8; --bg-2: #fff; --bg-3: #eceff2; --bg-inset: #f6f7f8; --line-1: #dadee3; --line-2: #c9cfd6; --ink-1: #0f1317; --ink-2: #414c57; --ink-3: #66727e; --ink-4: #949eaa; --ok: #0b9465; --warn: #b06f06; --bad: #d3362b; --info: #2a6fd0; --accent: #e0590a; }
  .matrix th { position: static; }
  .card, .matrix-wrap { box-shadow: none; }
  tr { break-inside: avoid; }
}
`;
