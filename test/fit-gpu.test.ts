import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { afterAll, describe, expect, it } from 'vitest';
import { gpuEmulationFor, gpuEmulationText, gpuRunText, runGpuEmulation, splitExtensions } from '../src/fit/gpu-emulate.js';
import { GL, GPU_READ_SCRIPT, gpuShimBookmarklet, gpuShimFile, gpuShimScript, parseGpuReport, type GpuEmulation } from '../src/fit/gpu-shim.js';
import { runFitCli } from '../src/fit/cli.js';
import type { FitPage } from '../src/fit/run.js';
import { loadProfiles } from '../src/profile/load.js';
import type { DeviceProfile } from '../src/profile/types.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'firelab-gpu-'));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));
const profiles = loadProfiles().profiles;

// ---------- a fake browser with a desktop-class GPU ----------

const HOST_EXT1 = ['ANGLE_instanced_arrays', 'EXT_color_buffer_half_float', 'OES_element_index_uint', 'OES_texture_float', 'OES_texture_float_linear', 'WEBGL_compressed_texture_s3tc', 'WEBGL_compressed_texture_astc', 'WEBGL_compressed_texture_etc', 'WEBGL_compressed_texture_etc1', 'WEBGL_debug_renderer_info', 'WEBGL_lose_context', 'WEBGL_depth_texture'];
const HOST_EXT2 = ['EXT_color_buffer_float', 'EXT_color_buffer_half_float', 'OES_texture_float_linear', 'WEBGL_compressed_texture_s3tc', 'WEBGL_compressed_texture_astc', 'WEBGL_compressed_texture_etc', 'WEBGL_debug_renderer_info', 'WEBGL_lose_context'];

/** A window with canvas + WebGL1/2 classes that behave like a 16384-texture desktop GPU, plus a log of real GL calls. */
function fakeBrowser() {
  const calls: string[] = [];
  const warnings: string[] = [];
  class WebGLRenderingContext {
    private err = 0;
    hostExt = HOST_EXT1;
    getSupportedExtensions() {
      return [...this.hostExt];
    }
    getExtension(name: string) {
      calls.push(`getExtension ${name}`);
      return this.hostExt.some((e) => e.toLowerCase() === name.toLowerCase()) ? { name } : null;
    }
    getParameter(p: number) {
      if (p === GL.MAX_TEXTURE_SIZE || p === GL.MAX_CUBE_MAP_TEXTURE_SIZE || p === GL.MAX_RENDERBUFFER_SIZE) return 16384;
      if (p === GL.MAX_VIEWPORT_DIMS) return new Int32Array([16384, 16384]);
      if (p === GL.MAX_VERTEX_TEXTURE_IMAGE_UNITS) return 16;
      if (p === 0x9246) return 'ANGLE (Apple M1)';
      if (p === 0x86a3) return new Uint32Array([0x83f0, 0x93b0, 0x9274]);
      return 7;
    }
    getShaderPrecisionFormat() {
      return { rangeMin: 127, rangeMax: 127, precision: 23 };
    }
    getError() {
      const e = this.err;
      this.err = 0;
      return e;
    }
    texImage2D(...a: unknown[]) {
      calls.push(`texImage2D ${a.length >= 8 ? `${a[3]}x${a[4]}` : 'source'}`);
    }
    compressedTexImage2D(_t: number, _l: number, fmt: number) {
      calls.push(`compressedTexImage2D 0x${fmt.toString(16)}`);
    }
    renderbufferStorage(_t: number, _f: number, w: number, h: number) {
      calls.push(`renderbufferStorage ${w}x${h}`);
    }
    createShader(type: number) {
      return { type };
    }
    shaderSource() {}
    compileShader() {}
    getShaderParameter() {
      return true;
    }
    getShaderInfoLog() {
      return '';
    }
    createProgram() {
      return {};
    }
    attachShader() {}
    linkProgram() {}
    getProgramParameter() {
      return true;
    }
    getProgramInfoLog() {
      return '';
    }
    useProgram() {
      calls.push('useProgram');
    }
    drawArrays() {}
  }
  class WebGL2RenderingContext extends WebGLRenderingContext {
    constructor() {
      super();
      this.hostExt = HOST_EXT2;
    }
    texStorage2D(_t: number, _l: number, _f: number, w: number, h: number) {
      calls.push(`texStorage2D ${w}x${h}`);
    }
    renderbufferStorageMultisample(_t: number, s: number) {
      calls.push(`renderbufferStorageMultisample ${s}`);
    }
  }
  class HTMLCanvasElement {
    getContext(type: string) {
      calls.push(`getContext ${type}`);
      if (type === 'webgl2') return new WebGL2RenderingContext();
      if (type === 'webgl' || type === 'experimental-webgl') return new WebGLRenderingContext();
      return null;
    }
  }
  class Navigator {}
  Object.defineProperty(Navigator.prototype, 'gpu', { configurable: true, get: () => ({ requestAdapter() {} }) });
  const window: Record<string, unknown> = {
    WebGLRenderingContext,
    WebGL2RenderingContext,
    HTMLCanvasElement,
    Navigator,
    navigator: new Navigator(),
    location: { href: 'http://game.test/' },
    performance: { now: () => 1234 },
    console: { warn: (s: string) => warnings.push(s), table() {} },
  };
  window.window = window;
  const ctx = vm.createContext(window);
  const run = (src: string) => vm.runInContext(src, ctx) as unknown;
  const canvas = () => new HTMLCanvasElement() as unknown as { getContext(t: string): (WebGLRenderingContext & Partial<WebGL2RenderingContext>) | null };
  return { run, canvas, calls, warnings, window };
}

const shimmed = (model: string) => {
  const b = fakeBrowser();
  b.run(gpuShimScript(gpuEmulationFor(model, profiles)));
  return b;
};

// ---------- tests ----------

describe('GPU capability profiles', () => {
  it('Fire TV Stick (3rd gen): GE8300 with WebGL2, 8192 textures, ASTC and no S3TC, FP16 mediump measured', () => {
    const e = gpuEmulationFor('AFTSSS', profiles);
    expect(e).toMatchObject({ model: 'AFTSSS', renderer: 'PowerVR Rogue GE8300', webgl1: true, webgl2: true, fragmentHighp: true, webgpu: false });
    expect(e.limits[GL.MAX_TEXTURE_SIZE]).toBe(8192);
    expect(e.limits[GL.MAX_VIEWPORT_DIMS]).toEqual([8192, 8192]);
    expect(e.extensions.webgl2).toContain('WEBGL_compressed_texture_astc');
    expect(e.extensions.webgl2).toContain('EXT_color_buffer_float');
    expect(e.extensions.webgl1).not.toContain('EXT_color_buffer_float');
    expect(e.extensions.webgl2).not.toContain('OES_texture_float');
    for (const l of [e.extensions.webgl1, e.extensions.webgl2]) {
      expect(l).not.toContain('WEBGL_compressed_texture_s3tc');
      expect(l).not.toContain('OES_texture_float_linear');
    }
    expect(e.precision[`${GL.FRAGMENT_SHADER}:${GL.MEDIUM_FLOAT}`]).toEqual({ rangeMin: 15, rangeMax: 15, precision: 10 });
    const fact = (n: string) => e.facts.find((f) => f.name === n);
    expect(fact('UNMASKED_RENDERER_WEBGL')?.source).toBe('measured');
    expect(fact('WebGL2')?.source).toBe('measured');
    expect(fact('MAX_TEXTURE_SIZE')?.source).toBe('estimated');
    expect(fact('fragment mediump')?.source).toBe('measured');
    expect(e.notes.join(' ')).toMatch(/not the stick's/);
  });

  it('Mali-450 sticks: no WebGL2, 4096 textures, no vertex textures, no fragment highp, ETC1 only', () => {
    const e = gpuEmulationFor('aftt', profiles);
    expect(e).toMatchObject({ model: 'AFTT', renderer: 'Mali-450 MP4', webgl2: false, fragmentHighp: false, compressed: ['etc1'] });
    expect(e.limits[GL.MAX_TEXTURE_SIZE]).toBe(4096);
    expect(e.limits[GL.MAX_VERTEX_TEXTURE_IMAGE_UNITS]).toBe(0);
    expect(e.limits[GL.MAX_SAMPLES]).toBeUndefined();
    expect(e.extensions.webgl2).toEqual([]);
    expect(e.extensions.webgl1).toContain('WEBGL_compressed_texture_etc1');
    expect(e.extensions.webgl1).not.toContain('ANGLE_instanced_arrays');
    expect(e.extensions.webgl1).not.toContain('OES_element_index_uint');
    expect(e.precision[`${GL.FRAGMENT_SHADER}:${GL.HIGH_FLOAT}`]).toEqual({ rangeMin: 0, rangeMax: 0, precision: 0 });
    expect(e.facts.find((f) => f.name === 'WebGL2')?.source).toBe('spec');
  });

  it('a GPU whose WebGL2 depends on the blocklist gets the worst case, and says so', () => {
    const e = gpuEmulationFor('AFTS', profiles);
    expect(e.webgl2).toBe(false);
    expect(e.compressed).not.toContain('astc');
    expect(e.notes.join(' ')).toMatch(/worst case/);
    expect(gpuEmulationText(e)).toMatch(/WebGL2 +no \(worst case\) +\[estimated/);
  });

  it('measured profile values win over the family estimates', () => {
    const base = profiles.get('AFTSSS') as DeviceProfile;
    const p: DeviceProfile = JSON.parse(JSON.stringify(base));
    p.webgl.maxTextureSize = { value: 4096, source: 'measured', note: 'WebGL2 context' };
    p.webgl.extensions = { value: ['EXT_color_buffer_float', 'OES_texture_float', 'WEBGL_compressed_texture_etc', 'WEBGL_lose_context'], source: 'measured' };
    const e = gpuEmulationFor('AFTSSS', new Map([...profiles, ['AFTSSS', p]]));
    expect(e.limits[GL.MAX_TEXTURE_SIZE]).toBe(4096);
    expect(e.extensions).toEqual({ webgl1: ['OES_texture_float', 'WEBGL_compressed_texture_etc', 'WEBGL_lose_context'], webgl2: ['EXT_color_buffer_float', 'WEBGL_compressed_texture_etc', 'WEBGL_lose_context'] });
    expect(e.facts.find((f) => f.name === 'MAX_TEXTURE_SIZE')?.source).toBe('measured');
    expect(splitExtensions(['EXT_color_buffer_half_float']).webgl2).toEqual(['EXT_color_buffer_half_float']);
  });

  it('unknown models are refused', () => {
    expect(() => gpuEmulationFor('NOPE')).toThrow(/Unknown Fire TV model/);
  });
});

describe('the shim', () => {
  it('refuses WebGL2 on a Mali-450 the way the driver does, and WebGL1 still works', () => {
    const b = shimmed('AFTT');
    expect(b.canvas().getContext('webgl2')).toBeNull();
    expect(b.calls).not.toContain('getContext webgl2');
    const gl = b.canvas().getContext('webgl');
    expect(gl).not.toBeNull();
    expect(gl?.getParameter(0x9246)).toBe('Mali-450 MP4');
    const r = parseGpuReport(b.run(GPU_READ_SCRIPT));
    expect(r).toMatchObject({ installed: true, model: 'AFTT', contexts: { webgl: 1, webgl2: 0, refused: 1 } });
    expect(r.failures[0]).toMatchObject({ sev: 'fail', call: 'getContext("webgl2")' });
    expect(b.warnings[0]).toMatch(/^\[firelab-gpu\] AFTT \(Mali-450 MP4\): getContext\("webgl2"\) returned null/);
    expect(r.contexts.drew1).toBe(false);
    (gl as unknown as { drawArrays(): void }).drawArrays();
    expect(parseGpuReport(b.run(GPU_READ_SCRIPT)).contexts.drew1).toBe(true);
  });

  it('caps limits at the GPU and rejects a texture over MAX_TEXTURE_SIZE with INVALID_VALUE', () => {
    const b = shimmed('AFTT');
    const g = b.canvas().getContext('webgl') as unknown as { getParameter(p: number): unknown; texImage2D(...a: unknown[]): void; getError(): number; renderbufferStorage(...a: number[]): void };
    expect(g.getParameter(GL.MAX_TEXTURE_SIZE)).toBe(4096);
    expect(Array.from(g.getParameter(GL.MAX_VIEWPORT_DIMS) as Int32Array)).toEqual([4096, 4096]);
    expect(g.getParameter(GL.MAX_VERTEX_TEXTURE_IMAGE_UNITS)).toBe(0);
    expect(g.getParameter(0x1234)).toBe(7); // not limited: the host's value
    g.texImage2D(0x0de1, 0, 0x1908, 8192, 8192, 0, 0x1908, 0x1401, null);
    expect(g.getError()).toBe(0x0501);
    expect(g.getError()).toBe(0);
    g.texImage2D(0x0de1, 0, 0x1908, 0x1908, 0x1401, { naturalWidth: 6000, naturalHeight: 100 });
    g.texImage2D(0x0de1, 1, 0x1908, 4096, 4096, 0, 0x1908, 0x1401, null); // level 1 allows 2048
    g.texImage2D(0x0de1, 0, 0x1908, 1024, 1024, 0, 0x1908, 0x1401, null);
    g.renderbufferStorage(0x8d41, 0x81a5, 5000, 10);
    expect(b.calls.filter((c) => /^texImage2D|^renderbuffer/.test(c))).toEqual(['texImage2D 1024x1024']);
    const fails = parseGpuReport(b.run(GPU_READ_SCRIPT)).failures.map((f) => f.detail);
    expect(fails).toEqual(expect.arrayContaining([expect.stringMatching(/^8192x8192 is over MAX_TEXTURE_SIZE 4096/), expect.stringMatching(/^6000x100/), expect.stringMatching(/at mip level 1/), expect.stringMatching(/over MAX_RENDERBUFFER_SIZE 4096/)]));
  });

  it('hides extensions and compressed formats the GPU lacks', () => {
    const b = shimmed('AFTSSS');
    const gl = b.canvas().getContext('webgl2') as unknown as { getExtension(n: string): unknown; getSupportedExtensions(): string[]; getParameter(p: number): unknown; compressedTexImage2D(...a: unknown[]): void; getError(): number; renderbufferStorageMultisample(...a: number[]): void };
    expect(gl.getExtension('WEBGL_compressed_texture_s3tc')).toBeNull();
    expect(gl.getExtension('webgl_compressed_texture_astc')).not.toBeNull();
    expect(gl.getExtension('OES_texture_float_linear')).toBeNull();
    expect(gl.getExtension('MOZ_EXT_texture_filter_anisotropic')).toBeNull();
    expect(gl.getExtension('EXT_color_buffer_float')).not.toBeNull();
    expect(gl.getSupportedExtensions()).toEqual(['EXT_color_buffer_float', 'EXT_color_buffer_half_float', 'WEBGL_compressed_texture_astc', 'WEBGL_compressed_texture_etc', 'WEBGL_debug_renderer_info', 'WEBGL_lose_context']);
    expect(Array.from(gl.getParameter(0x86a3) as Uint32Array)).toEqual([0x93b0, 0x9274]);
    gl.compressedTexImage2D(0x0de1, 0, 0x83f0, 256, 256, 0, new Uint8Array(8));
    expect(gl.getError()).toBe(0x0500);
    gl.compressedTexImage2D(0x0de1, 0, 0x93b0, 256, 256, 0, new Uint8Array(8));
    gl.renderbufferStorageMultisample(0x8d41, 8, 0x8058, 64, 64);
    expect(gl.getError()).toBe(0x0502);
    expect(b.calls).toContain('compressedTexImage2D 0x93b0');
    expect(b.calls).not.toContain('compressedTexImage2D 0x83f0');
    expect(b.calls).not.toContain('getExtension WEBGL_compressed_texture_s3tc');
    const r = parseGpuReport(b.run(GPU_READ_SCRIPT));
    expect(r.failures.find((f) => f.call === 'getExtension("WEBGL_compressed_texture_s3tc")')).toMatchObject({ sev: 'warn' });
    expect(r.failures.some((f) => f.call.includes('MOZ_'))).toBe(false);
    expect(r.failures.find((f) => f.call === 'compressedTexImage2D')).toMatchObject({ sev: 'fail', detail: expect.stringMatching(/^S3TC texture/) });
    // PVRTC is on the stick but not on this host: it can't be emulated here.
    expect(r.hostMissing).toContain('WEBGL_compressed_texture_pvrtc');
  });

  it('reports FP16 mediump and fails highp fragment shaders and vertex textures on Utgard', () => {
    const b = shimmed('AFTT');
    type G = { getShaderPrecisionFormat(s: number, p: number): { precision: number }; createShader(t: number): object; shaderSource(s: object, src: string): void; compileShader(s: object): void; getShaderParameter(s: object, p: number): boolean; getShaderInfoLog(s: object): string; createProgram(): object; attachShader(p: object, s: object): void; linkProgram(p: object): void; getProgramParameter(p: object, n: number): boolean; useProgram(p: object): void; getError(): number };
    const gl = b.canvas().getContext('webgl') as unknown as G;
    expect(gl.getShaderPrecisionFormat(GL.FRAGMENT_SHADER, GL.MEDIUM_FLOAT).precision).toBe(10);
    expect(gl.getShaderPrecisionFormat(GL.FRAGMENT_SHADER, GL.HIGH_FLOAT).precision).toBe(0);
    expect(gl.getShaderPrecisionFormat(GL.VERTEX_SHADER, GL.HIGH_FLOAT).precision).toBe(23);
    const compile = (type: number, src: string) => {
      const s = gl.createShader(type);
      gl.shaderSource(s, src);
      gl.compileShader(s);
      return s;
    };
    const bad = compile(GL.FRAGMENT_SHADER, 'precision highp float;\nvoid main() { gl_FragColor = vec4(1.0); }');
    expect(gl.getShaderParameter(bad, 0x8b81)).toBe(false);
    expect(gl.getShaderInfoLog(bad)).toMatch(/'highp' : precision not supported/);
    const guarded = compile(GL.FRAGMENT_SHADER, '#ifdef GL_FRAGMENT_PRECISION_HIGH\nprecision highp float;\n#else\nprecision mediump float;\n#endif\nvoid main() {}');
    expect(gl.getShaderParameter(guarded, 0x8b81)).toBe(true);
    const comment = compile(GL.FRAGMENT_SHADER, '// highp would be nice\nprecision mediump float; void main() {}');
    expect(gl.getShaderParameter(comment, 0x8b81)).toBe(true);
    const vtf = compile(GL.VERTEX_SHADER, 'uniform sampler2D boneTexture; void main() { gl_Position = texture2D(boneTexture, vec2(0.0)); }');
    expect(gl.getShaderParameter(vtf, 0x8b81)).toBe(false);
    const prog = gl.createProgram();
    gl.attachShader(prog, vtf);
    gl.attachShader(prog, guarded);
    gl.linkProgram(prog);
    expect(gl.getProgramParameter(prog, 0x8b82)).toBe(false);
    gl.useProgram(prog);
    expect(gl.getError()).toBe(0x0502);
    expect(b.calls).not.toContain('useProgram');
  });

  it('hides WebGPU, counts repeats once, and the file/bookmarklet forms carry the same caps', () => {
    const b = shimmed('AFTKM');
    expect((b.window.navigator as { gpu?: unknown }).gpu).toBeUndefined();
    expect((b.window.navigator as { gpu?: unknown }).gpu).toBeUndefined();
    const r = parseGpuReport(b.run(GPU_READ_SCRIPT));
    expect(r.failures).toEqual([expect.objectContaining({ call: 'navigator.gpu', sev: 'warn', n: 2 })]);
    expect(r.total).toBe(2);
    const e = gpuEmulationFor('AFTKM', profiles);
    expect(gpuShimFile(e)).toMatch(/^\/\/ ==UserScript==[\s\S]*@run-at\s+document-start[\s\S]*"renderer":"PowerVR Rogue GE9215"/);
    const bm = gpuShimBookmarklet(e);
    expect(bm.startsWith('javascript:')).toBe(true);
    expect(decodeURIComponent(bm.slice('javascript:'.length))).toContain('__firelabGpu');
    // Installing twice is harmless.
    b.run(gpuShimScript(e));
    expect(parseGpuReport(b.run(GPU_READ_SCRIPT)).total).toBe(2);
  });

  it('without the shim the read script says so', () => {
    const b = fakeBrowser();
    expect(parseGpuReport(b.run(GPU_READ_SCRIPT))).toMatchObject({ installed: false, url: 'http://game.test/', failures: [] });
  });
});

/** A FitPage over the fake browser: init scripts run on every navigation/reload. */
function fakePage(start = 'http://game.test/') {
  let b = fakeBrowser();
  const inits = new Map<string, string>();
  const log: string[] = [];
  let url = start;
  const load = (u: string) => {
    url = u;
    b = fakeBrowser();
    (b.window.location as { href: string }).href = u;
    for (const s of inits.values()) b.run(s);
    // The game: wants WebGL2, falls back to WebGL1, uploads a 4K texture.
    const c = b.canvas();
    const gl = c.getContext('webgl2') ?? b.canvas().getContext('webgl');
    (gl as unknown as { texImage2D(...a: unknown[]): void })?.texImage2D(0x0de1, 0, 0x1908, 4096, 4096, 0, 0x1908, 0x1401, null);
  };
  const page: FitPage = {
    closed: false,
    eval: async <T>(expr: string) => b.run(expr) as T,
    currentUrl: async () => url,
    navigate: async (u) => {
      log.push(`navigate ${u}`);
      load(u);
      return { loaded: true };
    },
    reload: async () => {
      log.push('reload');
      load(url);
      return { loaded: true };
    },
    addInitScript: async (src) => {
      const id = String(inits.size + 1);
      inits.set(id, src);
      log.push(`addInitScript ${id}`);
      return id;
    },
    removeInitScript: async (id) => {
      inits.delete(id);
      log.push(`removeInitScript ${id}`);
    },
    installProbe: async () => {},
    resetFps: async () => {},
    readFps: async () => [],
    close: () => {},
  };
  return { page, log };
}

describe('runGpuEmulation', () => {
  it('loads the page with the shim, reports what failed, removes the shim and restores the page', async () => {
    const { page, log } = fakePage();
    const r = await runGpuEmulation(page, gpuEmulationFor('AFTT', profiles), { url: 'http://game.test/play', seconds: 3, sleep: async () => {} });
    expect(log).toEqual(['addInitScript 1', 'navigate http://game.test/play', 'removeInitScript 1', 'navigate http://game.test/']);
    expect(r).toMatchObject({ installed: true, model: 'AFTT', seconds: 3, url: 'http://game.test/play', contexts: { webgl: 1, webgl2: 0, refused: 1 } });
    expect(r.failures.map((f) => f.call)).toEqual(['getContext("webgl2")']);
    const text = gpuRunText(r);
    expect(text).toMatch(/^Fire TV Stick \(2nd gen\) \/ Basic Edition \(AFTT\), Mali-450 MP4: 1 kind of WebGL call failed/);
    expect(text).toMatch(/❌ getContext\("webgl2"\) returned null/);
  });

  it('a GE9215 runs the same game without failures (reload when no URL)', async () => {
    const { page, log } = fakePage();
    const r = await runGpuEmulation(page, gpuEmulationFor('AFTKA', profiles), { seconds: 1, sleep: async () => {}, restore: false });
    expect(log).toEqual(['addInitScript 1', 'reload', 'removeInitScript 1']);
    expect(r.failures).toEqual([]);
    expect(gpuRunText(r)).toMatch(/no WebGL call failed/);
  });

  it('needs DevTools init scripts', async () => {
    const { page } = fakePage();
    delete page.addInitScript;
    await expect(runGpuEmulation(page, gpuEmulationFor('AFTT', profiles), { sleep: async () => {} })).rejects.toThrow(/needs DevTools/);
  });
});

describe('firelab fit --emulate-gpu', () => {
  const io = () => {
    const out: string[] = [];
    const err: string[] = [];
    return { out, err, io: { out: (s: string) => out.push(s), err: (s: string) => err.push(s) } };
  };

  it('--script writes a userscript, --static prints the profile, --json the emulation', async () => {
    const a = io();
    const file = path.join(tmp, 'gpu.js');
    expect(await runFitCli('fit', ['--emulate-gpu', 'AFTT', '--script', file], a.io)).toBe(0);
    expect(fs.readFileSync(file, 'utf8')).toMatch(/FireLab GPU emulation: Fire TV Stick \(2nd gen\)/);
    expect(a.out.join('\n')).toMatch(/Copies WebGL features and limits, not speed/);
    const b = io();
    expect(await runFitCli('fit', ['--emulate-gpu', 'AFTSSS,AFTT', '--static', '--json'], b.io)).toBe(0);
    const j = JSON.parse(b.out.join('\n')) as GpuEmulation[];
    expect(j.map((x) => [x.model, x.webgl2])).toEqual([['AFTSSS', true], ['AFTT', false]]);
    const c = io();
    expect(await runFitCli('fit', ['--emulate-gpu', 'AFTSSS', '--bookmarklet'], c.io)).toBe(0);
    expect(c.out[0]).toMatch(/^javascript:/);
  });

  it('bad input', async () => {
    const a = io();
    expect(await runFitCli('fit', ['--emulate-gpu', 'NOPE', '--static'], a.io)).toBe(1);
    expect(a.err.join('\n')).toMatch(/Unknown Fire TV model "NOPE"/);
    const b = io();
    expect(await runFitCli('fit', ['--script', 'x.js'], b.io)).toBe(1);
    expect(b.err.join('\n')).toMatch(/go with --emulate-gpu/);
  });
});
