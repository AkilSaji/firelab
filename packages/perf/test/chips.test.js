import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { CHIPS, FIRE_TV_MODELS, classifyGpu, classifyDevice, parseUserAgent, cleanGpuName, readGpu, detectDevice } from '../chips.js';
import { isTier } from '../index.js';

// Real WebGL renderer strings (as reported by WEBGL_debug_renderer_info),
// with the tier and chip entry each should map to.
const RENDERERS = [
  // Fire TV and other PowerVR
  ['PowerVR Rogue GE8300', 'tv', 'powervr-ge8300'],
  ['ANGLE (Imagination Technologies, PowerVR Rogue GE8300, OpenGL ES 3.2)', 'tv', 'powervr-ge8300'],
  ['PowerVR Rogue GE8320', 'tv', 'powervr-ge83xx'],
  ['PowerVR Rogue GE8322', 'tv', 'powervr-ge83xx'],
  ['PowerVR Rogue GE8100', 'low', 'powervr-ge8100'],
  ['PowerVR Rogue GE9215', 'tv-hd', 'powervr-ge9215'],
  ['IMG GE9215', 'tv-hd', 'powervr-ge9215'],
  ['PowerVR Rogue GE9210', 'tv-hd', 'powervr-ge9xxx'],
  ['PowerVR Rogue GE9608', 'tv-hd', 'powervr-ge9xxx'],
  ['PowerVR Rogue GM9446', 'tv-hd', 'powervr-gm9xxx'],
  ['PowerVR Rogue GX6250', 'tv', 'powervr-rogue-6-7'],
  ['PowerVR Rogue G6200', 'tv', 'powervr-rogue-6-7'],
  ['PowerVR Rogue GT7600 Plus', 'tv', 'powervr-rogue-6-7'],
  ['PowerVR SGX 544MP', 'low', 'powervr-sgx'],
  ['PowerVR B-Series BXM-8-256', 'tv-hd', 'powervr-b-series'],
  ['IMG BXM-8-256', 'tv-hd', 'powervr-b-series'],
  ['IMG BXE-4-32', 'tv-hd', 'powervr-b-series'],
  ['PowerVR D-Series DXT-48-1536', 'tv-hd', 'powervr-c-d-series'],
  ['PowerVR Rogue Hood', 'tv', 'powervr-other'],
  // Arm Mali
  ['Mali-400 MP', 'low', 'mali-utgard'],
  ['Mali-450 MP', 'low', 'mali-utgard'],
  ['Mali-470 MP', 'low', 'mali-utgard'],
  ['Mali-T720', 'low', 'mali-midgard-entry'],
  ['Mali-T760', 'low', 'mali-midgard-entry'],
  ['Mali-T820', 'low', 'mali-midgard-entry'],
  ['Mali-T830', 'low', 'mali-midgard-entry'],
  ['Mali-T628', 'low', 'mali-midgard-entry'],
  ['Mali-T880', 'tv', 'mali-midgard-high'],
  ['Mali-G31', 'tv', 'mali-entry-bifrost'],
  ['ANGLE (ARM, Mali-G31 MC2, OpenGL ES 3.2)', 'tv', 'mali-entry-bifrost'],
  ['Mali-G51', 'tv', 'mali-entry-bifrost'],
  ['Mali-G310', 'tv', 'mali-entry-bifrost'],
  ['Mali-G52', 'tv-hd', 'mali-mid'],
  ['Mali-G52 MC2', 'tv-hd', 'mali-mid'],
  ['ANGLE (ARM, Mali-G52 MC2, OpenGL ES 3.2)', 'tv-hd', 'mali-mid'],
  ['Mali-G57 MC2', 'tv-hd', 'mali-mid'],
  ['Mali-G68 MC4', 'tv-hd', 'mali-mid'],
  ['Mali-G76', 'tv-hd', 'mali-mid'],
  ['Mali-G610 MC6', 'tv-hd', 'mali-mid'],
  ['Mali-G710 MC10', 'tv-hd', 'mali-mid'],
  ['Mali-G715-Immortalis MC11', 'tv-hd', 'mali-mid'],
  ['Immortalis-G925', 'tv-hd', 'mali-mid'],
  ['Mali-G', 'tv', 'mali-other'],
  // Qualcomm Adreno
  ['Adreno (TM) 306', 'low', 'adreno-2xx-30x'],
  ['Adreno (TM) 308', 'low', 'adreno-2xx-30x'],
  ['Adreno (TM) 205', 'low', 'adreno-2xx-30x'],
  ['Adreno (TM) 320', 'tv', 'adreno-3xx-5xx'],
  ['Adreno (TM) 405', 'tv', 'adreno-3xx-5xx'],
  ['Adreno (TM) 506', 'tv', 'adreno-3xx-5xx'],
  ['Adreno (TM) 540', 'tv', 'adreno-3xx-5xx'],
  ['Adreno (TM) 610', 'tv-hd', 'adreno-6xx-plus'],
  ['Adreno (TM) 650', 'tv-hd', 'adreno-6xx-plus'],
  ['ANGLE (Qualcomm, Adreno (TM) 640, OpenGL ES 3.2)', 'tv-hd', 'adreno-6xx-plus'],
  ['Adreno (TM) 740', 'tv-hd', 'adreno-6xx-plus'],
  ['Adreno (TM) 830', 'tv-hd', 'adreno-6xx-plus'],
  ['Qualcomm Adreno', 'tv', 'adreno-other'],
  ['ANGLE (Qualcomm, Qualcomm(R) Adreno(TM) X1-85 GPU (0x36334330) Direct3D11 vs_5_0 ps_5_0, D3D11)', 'high', 'adreno-windows'],
  ['ANGLE (Qualcomm, Qualcomm(R) Adreno(TM) 8cx Gen 3 Direct3D11 vs_5_0 ps_5_0, D3D11)', 'high', 'adreno-windows'],
  // NVIDIA
  ['NVIDIA Tegra X1 (nvgpu)/integrated', 'tv-hd', 'tegra-x1'],
  ['NVIDIA Tegra', 'tv-hd', 'tegra-x1'],
  ['NVIDIA Tegra 3', 'low', 'tegra-old'],
  ['NVIDIA Tegra K1', 'tv', 'tegra-k1'],
  ['ANGLE (NVIDIA, NVIDIA GeForce RTX 3070 (0x00002484) Direct3D11 vs_5_0 ps_5_0, D3D11)', 'high', 'nvidia-desktop'],
  ['NVIDIA GeForce GTX 1060/PCIe/SSE2', 'high', 'nvidia-desktop'],
  ['ANGLE (NVIDIA Corporation, NVIDIA GeForce RTX 4090/PCIe/SSE2, OpenGL 4.5.0)', 'high', 'nvidia-desktop'],
  // AMD
  ['ANGLE (AMD, AMD Radeon RX 580 Series Direct3D11 vs_5_0 ps_5_0, D3D11)', 'high', 'amd'],
  ['AMD Radeon Pro 5500M OpenGL Engine', 'high', 'amd'],
  ['ANGLE (AMD, AMD Radeon(TM) Graphics (0x00001638) Direct3D11 vs_5_0 ps_5_0, D3D11)', 'high', 'amd'],
  // Intel
  ['ANGLE (Intel, Intel(R) UHD Graphics 620 (0x00005917) Direct3D11 vs_5_0 ps_5_0, D3D11)', 'high', 'intel'],
  ['Mesa Intel(R) UHD Graphics 620 (KBL GT2)', 'high', 'intel'],
  ['ANGLE (Intel, Mesa Intel(R) Xe Graphics (TGL GT2), OpenGL 4.6)', 'high', 'intel'],
  ['Intel(R) Iris(TM) Plus Graphics 640', 'high', 'intel'],
  ['ANGLE (Intel, Intel(R) HD Graphics 500 Direct3D11 vs_5_0 ps_5_0, D3D11)', 'tv', 'intel-entry'],
  ['Mesa DRI Intel(R) HD Graphics 400 (Braswell)', 'tv', 'intel-entry'],
  ['Mesa DRI Intel(R) Bay Trail', 'tv', 'intel-entry'],
  // Apple
  ['ANGLE (Apple, ANGLE Metal Renderer: Apple M1 Pro, Unspecified Version)', 'high', 'apple-m'],
  ['Apple M2', 'high', 'apple-m'],
  ['Apple A15 GPU', 'tv-hd', 'apple-a'],
  ['Apple GPU', 'high', 'apple-gpu'],
  // Software
  ['ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero) (0x0000C0DE)), SwiftShader driver)', 'low', 'software'],
  ['Google SwiftShader', 'low', 'software'],
  ['llvmpipe (LLVM 15.0.7, 256 bits)', 'low', 'software'],
  ['Microsoft Basic Render Driver', 'low', 'software'],
  // Others
  ['Vivante GC1000', 'low', 'vivante'],
  ['VideoCore IV HW', 'low', 'videocore-old'],
  ['V3D 4.2', 'low', 'videocore-old'],
  ['V3D 7.1', 'tv', 'videocore-new'],
  ['Samsung Xclipse 920', 'tv-hd', 'xclipse'],
];

describe('classifyGpu', () => {
  for (const [renderer, tier, id] of RENDERERS) {
    test(`${renderer} -> ${tier}`, () => {
      const chip = classifyGpu(renderer);
      assert.ok(chip, `no match for ${renderer}`);
      assert.equal(chip.id, id);
      assert.equal(chip.tier, tier);
    });
  }

  test('unknown and empty renderers give null', () => {
    assert.equal(classifyGpu('Some Future GPU 9000'), null);
    assert.equal(classifyGpu(''), null);
    assert.equal(classifyGpu(null), null);
    assert.equal(classifyGpu(undefined), null);
  });

  test('the measured stick GPUs carry their measurements', () => {
    assert.match(classifyGpu('PowerVR Rogue GE8300').measured, /27 fps/);
    assert.match(classifyGpu('PowerVR Rogue GE9215').measured, /1080p/);
  });
});

describe('chip table', () => {
  test('every entry is complete and has a unique id', () => {
    const ids = new Set();
    for (const c of CHIPS) {
      assert.ok(c.id && !ids.has(c.id), `duplicate or empty id ${c.id}`);
      ids.add(c.id);
      assert.ok(c.match instanceof RegExp, c.id);
      assert.ok(isTier(c.tier), c.id);
      assert.ok(c.family.length > 3, c.id);
      assert.ok(c.why.length > 10, `${c.id} needs a reason`);
      assert.ok(!c.match.global, `${c.id}: a global regex keeps state between tests`);
    }
  });

  test('every chip entry is reachable (not shadowed by an earlier entry)', () => {
    const reached = new Set(RENDERERS.map(([r]) => classifyGpu(r)?.id));
    for (const c of CHIPS) assert.ok(reached.has(c.id), `${c.id} has no test string that reaches it`);
  });

  test('Fire TV model hints agree with the chip table', () => {
    for (const [model, m] of Object.entries(FIRE_TV_MODELS)) {
      const chip = classifyGpu(m.gpu);
      assert.ok(chip, `${model}: ${m.gpu} not in the chip table`);
      assert.equal(chip.tier, m.tier, `${model}: ${m.gpu}`);
    }
  });
});

const UA = {
  stick3: 'Mozilla/5.0 (Linux; Android 9; AFTSSS Build/PS7717; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/138.0.7204.0 Mobile Safari/537.36',
  stick4kmax2: 'Mozilla/5.0 (Linux; Android 11; AFTMA08C15 Build/RS8149; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/138.0.7204.0 Mobile Safari/537.36',
  silk: 'Mozilla/5.0 (Linux; Android 9; AFTMM Build/PS7633) AppleWebKit/537.36 (KHTML, like Gecko) Silk/120.3.1 like Chrome/120.0.6099.230 Safari/537.36',
  unknownFire: 'Mozilla/5.0 (Linux; Android 9; AFTXYZ Build/PS1; wv) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36',
  mibox: 'Mozilla/5.0 (Linux; Android 9; MIBOX4 Build/PI; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/108.0.5359.128 Safari/537.36',
  shield: 'Mozilla/5.0 (Linux; Android 11; SHIELD Android TV Build/RQ1A.210105.003; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/120.0 Safari/537.36',
  chromecast: 'Mozilla/5.0 (Linux; Android 12; Chromecast Build/STTE.230319.008; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/120.0 Safari/537.36',
  pixel: 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Mobile Safari/537.36',
  iphone: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1',
  mac: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36',
  windows: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36',
  tizen: 'Mozilla/5.0 (SMART-TV; LINUX; Tizen 6.0) AppleWebKit/537.36 (KHTML, like Gecko) 76.0.3809.146/6.0 TV Safari/537.36',
  webos: 'Mozilla/5.0 (Web0S; Linux/SmartTV) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/94.0.4606.128 Safari/537.36 WebAppManager',
  fireTablet: 'Mozilla/5.0 (Linux; Android 11; KFTRWI) AppleWebKit/537.36 (KHTML, like Gecko) Silk/126.4.1 like Chrome/126.0.6478.231 Safari/537.36',
  wrapped: 'Mozilla/5.0 (Linux; Android 9; AFTSSS Build/PS7717; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/138.0 Mobile Safari/537.36 FireLab/0.1.0',
};

describe('parseUserAgent', () => {
  test('Fire TV Stick (3rd gen) WebView', () => {
    const u = parseUserAgent(UA.stick3);
    assert.equal(u.platform, 'firetv');
    assert.equal(u.isTv, true);
    assert.equal(u.model, 'AFTSSS');
    assert.equal(u.device, 'Fire TV Stick (3rd gen, 2020)');
    assert.equal(u.wrapped, true);
  });
  test('Fire TV Stick 4K Max (2nd gen)', () => {
    const u = parseUserAgent(UA.stick4kmax2);
    assert.equal(u.model, 'AFTMA08C15');
    assert.equal(u.device, 'Fire TV Stick 4K Max (2nd gen)');
  });
  test('Silk on a Fire TV is a Fire TV, not wrapped', () => {
    const u = parseUserAgent(UA.silk);
    assert.equal(u.platform, 'firetv');
    assert.equal(u.model, 'AFTMM');
    assert.equal(u.wrapped, false);
  });
  test('unknown Fire TV model still counts as a Fire TV', () => {
    const u = parseUserAgent(UA.unknownFire);
    assert.equal(u.platform, 'firetv');
    assert.equal(u.device, 'Fire TV');
  });
  test('Android TV boxes', () => {
    for (const ua of [UA.mibox, UA.shield, UA.chromecast]) assert.equal(parseUserAgent(ua).platform, 'androidtv', ua);
    assert.equal(parseUserAgent(UA.mibox).model, 'MIBOX4');
    assert.equal(parseUserAgent(UA.shield).model, 'SHIELD Android TV');
  });
  test('other TV platforms', () => {
    assert.equal(parseUserAgent(UA.tizen).platform, 'tv');
    assert.equal(parseUserAgent(UA.webos).platform, 'tv');
  });
  test('phones and tablets', () => {
    const p = parseUserAgent(UA.pixel);
    assert.equal(p.platform, 'mobile');
    assert.equal(p.model, null, 'the reduced user agent model "K" means nothing');
    assert.equal(parseUserAgent(UA.iphone).platform, 'mobile');
    assert.equal(parseUserAgent(UA.fireTablet).platform, 'mobile');
    assert.equal(parseUserAgent(UA.mac, { maxTouchPoints: 5 }).platform, 'mobile', 'iPadOS claims to be a Mac');
  });
  test('desktops', () => {
    assert.equal(parseUserAgent(UA.mac).platform, 'desktop');
    assert.equal(parseUserAgent(UA.windows).platform, 'desktop');
    assert.equal(parseUserAgent('').platform, 'desktop');
    assert.equal(parseUserAgent(UA.mac).isTv, false);
  });
  test('FireLab wrapper marker', () => {
    assert.equal(parseUserAgent(UA.wrapped).wrapped, true);
  });
});

describe('classifyDevice', () => {
  test('Fire TV Stick (3rd gen): GE8300 -> tv', () => {
    const d = classifyDevice({ renderer: 'PowerVR Rogue GE8300', webgl: 2, ua: UA.stick3 });
    assert.equal(d.tier, 'tv');
    assert.equal(d.chip, 'powervr-ge8300');
    assert.equal(d.platform, 'firetv');
    assert.equal(d.gpu, 'PowerVR Rogue GE8300');
    assert.match(d.reason, /GE8300/);
  });
  test('Fire TV Stick 4K Max (2nd gen): GE9215 -> tv-hd', () => {
    assert.equal(classifyDevice({ renderer: 'PowerVR Rogue GE9215', webgl: 2, ua: UA.stick4kmax2 }).tier, 'tv-hd');
  });
  test('Mali-G31 Android TV box -> tv', () => {
    assert.equal(classifyDevice({ renderer: 'Mali-G31', webgl: 2, ua: UA.chromecast }).tier, 'tv');
  });
  test('old Mali-450 stick without WebGL2 -> low', () => {
    const d = classifyDevice({ renderer: 'Mali-450 MP', webgl: 1, ua: UA.mibox });
    assert.equal(d.tier, 'low');
    assert.equal(d.webgl, 1);
  });
  test('no WebGL at all -> low', () => {
    const d = classifyDevice({ renderer: '', webgl: 0, ua: UA.mac });
    assert.equal(d.tier, 'low');
    assert.match(d.reason, /WebGL is not available/);
  });
  test('WebGL1 only caps a capable GPU at low', () => {
    const d = classifyDevice({ renderer: 'Adreno (TM) 650', webgl: 1, ua: UA.pixel });
    assert.equal(d.tier, 'low');
    assert.match(d.reason, /no WebGL2/);
  });
  test('hidden GPU on a known Fire TV uses the model table', () => {
    const d = classifyDevice({ renderer: '', masked: true, webgl: 2, ua: UA.silk });
    assert.equal(d.tier, 'tv');
    assert.equal(d.gpu, 'PowerVR GE8300');
    assert.match(d.reason, /AFTMM/);
    assert.equal(classifyDevice({ renderer: '', masked: true, webgl: 2, ua: UA.stick4kmax2 }).tier, 'tv-hd');
  });
  test('unknown GPU: high on desktops, tv elsewhere', () => {
    assert.equal(classifyDevice({ renderer: 'Mystery GPU', webgl: 2, ua: UA.windows }).tier, 'high');
    assert.equal(classifyDevice({ renderer: 'Mystery GPU', webgl: 2, ua: UA.mibox }).tier, 'tv');
    assert.equal(classifyDevice({ renderer: 'Mystery GPU', webgl: 2, ua: UA.unknownFire }).tier, 'tv');
  });
  test('phones, tablets and TVs never get the desktop tier', () => {
    const d = classifyDevice({ renderer: 'Apple GPU', webgl: 2, ua: UA.iphone });
    assert.equal(d.tier, 'tv-hd');
    assert.match(d.reason, /Capped at tv-hd/);
    assert.equal(classifyDevice({ renderer: 'Apple GPU', webgl: 2, ua: UA.mac }).tier, 'high');
  });
  test('software rendering on a desktop -> low', () => {
    const d = classifyDevice({ renderer: 'ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero) (0x0000C0DE)), SwiftShader driver)', webgl: 2, ua: UA.mac });
    assert.equal(d.tier, 'low');
  });
  test('webgl defaults to 2 when a renderer is known', () => {
    assert.equal(classifyDevice({ renderer: 'Mali-G52' }).webgl, 2);
    assert.equal(classifyDevice({}).webgl, 0);
  });
});

describe('cleanGpuName', () => {
  const cases = [
    ['ANGLE (Apple, ANGLE Metal Renderer: Apple M1 Pro, Unspecified Version)', 'Apple M1 Pro'],
    ['ANGLE (Intel, Intel(R) UHD Graphics 620 (0x00005917) Direct3D11 vs_5_0 ps_5_0, D3D11)', 'Intel UHD Graphics 620'],
    ['ANGLE (NVIDIA, NVIDIA GeForce RTX 3070 (0x00002484) Direct3D11 vs_5_0 ps_5_0, D3D11)', 'NVIDIA GeForce RTX 3070'],
    ['ANGLE (ARM, Mali-G52 MC2, OpenGL ES 3.2)', 'Mali-G52 MC2'],
    ['Adreno (TM) 640', 'Adreno 640'],
    ['NVIDIA GeForce GTX 1060/PCIe/SSE2', 'NVIDIA GeForce GTX 1060'],
    ['PowerVR Rogue GE8300', 'PowerVR Rogue GE8300'],
    ['', ''],
  ];
  for (const [raw, clean] of cases) test(`${raw || '(empty)'} -> ${clean || '(empty)'}`, () => assert.equal(cleanGpuName(raw), clean));
});

// A minimal fake of the WebGL bits readGpu() touches.
function fakeDocument({ webgl2 = true, webgl1 = true, debug = true, renderer = 'PowerVR Rogue GE8300', masked = 'WebKit WebGL' } = {}) {
  const calls = { lost: 0, contexts: [] };
  const gl = {
    RENDERER: 0x1f01,
    VENDOR: 0x1f00,
    getExtension(name) {
      if (name === 'WEBGL_debug_renderer_info') return debug ? { UNMASKED_RENDERER_WEBGL: 0x9246, UNMASKED_VENDOR_WEBGL: 0x9245 } : null;
      if (name === 'WEBGL_lose_context') return { loseContext: () => calls.lost++ };
      return null;
    },
    getParameter(p) {
      return { 0x9246: renderer, 0x9245: 'Imagination Technologies', 0x1f01: masked, 0x1f00: 'WebKit' }[p];
    },
  };
  return {
    calls,
    createElement() {
      return {
        getContext(kind) {
          calls.contexts.push(kind);
          if (kind === 'webgl2') return webgl2 ? gl : null;
          return webgl1 ? gl : null;
        },
      };
    },
  };
}

describe('readGpu / detectDevice', () => {
  test('reads the unmasked renderer and releases the temporary context', () => {
    const doc = fakeDocument();
    const g = readGpu({ document: doc });
    assert.deepEqual(g, { renderer: 'PowerVR Rogue GE8300', vendor: 'Imagination Technologies', masked: false, webgl: 2 });
    assert.equal(doc.calls.lost, 1);
  });
  test('falls back to WebGL1', () => {
    const g = readGpu({ document: fakeDocument({ webgl2: false, renderer: 'Mali-450 MP' }) });
    assert.equal(g.webgl, 1);
    assert.equal(g.renderer, 'Mali-450 MP');
  });
  test('masked renderer: the generic "WebKit WebGL" is not a GPU name', () => {
    const g = readGpu({ document: fakeDocument({ debug: false }) });
    assert.equal(g.masked, true);
    assert.equal(g.renderer, '');
  });
  test('masked renderer with a sanitised name (Firefox) is kept', () => {
    const g = readGpu({ document: fakeDocument({ debug: false, masked: 'Adreno (TM) 640' }) });
    assert.equal(g.renderer, 'Adreno (TM) 640');
  });
  test('no WebGL', () => {
    assert.deepEqual(readGpu({ document: fakeDocument({ webgl2: false, webgl1: false }) }), { renderer: '', vendor: '', masked: true, webgl: 0 });
  });
  test('no document (Node) is harmless', () => {
    assert.equal(readGpu({}).webgl, 0);
  });
  test('detectDevice combines GPU and user agent', () => {
    const d = detectDevice({ document: fakeDocument({ renderer: 'PowerVR Rogue GE9215' }), navigator: { userAgent: UA.stick4kmax2, maxTouchPoints: 0 } });
    assert.equal(d.tier, 'tv-hd');
    assert.equal(d.device, 'Fire TV Stick 4K Max (2nd gen)');
  });
});
