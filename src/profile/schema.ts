/**
 * The device profile JSON Schema (profiles/schema.json is generated from
 * PROFILE_SCHEMA and a test keeps the two identical), plus a small,
 * dependency-free validator for the subset of JSON Schema it uses.
 */
import { FACT_SOURCES, VIDEO_CODECS, type DeviceProfile } from './types.js';

type Schema = Record<string, unknown>;

const fact = (valueSchema: Schema, description?: string): Schema => ({
  type: 'object',
  ...(description ? { description } : {}),
  required: ['value', 'source'],
  additionalProperties: false,
  properties: {
    value: { anyOf: [valueSchema, { type: 'null' }] },
    source: { $ref: '#/$defs/source' },
    note: { type: 'string' },
  },
});

const numberOrRange: Schema = {
  anyOf: [{ type: 'number', minimum: 0 }, { type: 'array', items: { type: 'number', minimum: 0 }, minItems: 2, maxItems: 2 }],
};

export const PROFILE_SCHEMA: Schema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  title: 'FireLab device profile',
  description: 'What one Fire TV / Android TV model really has, with the source of every value. Written by `firelab profile`; read by `firelab fit`.',
  type: 'object',
  required: ['schemaVersion', 'model', 'name', 'source', 'capturedAt', 'firelabVersion', 'os', 'cpu', 'memory', 'gpu', 'webgl', 'webview', 'media', 'display'],
  additionalProperties: false,
  properties: {
    $schema: { type: 'string' },
    schemaVersion: { const: 1 },
    model: { type: 'string', pattern: '^[A-Za-z0-9_.-]{2,40}$', description: 'ro.product.model, e.g. AFTSSS' },
    name: { type: 'string', minLength: 1 },
    source: { enum: ['measured', 'manual'], description: 'measured = written by `firelab profile`; manual = entered by hand from measurements' },
    capturedAt: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}' },
    firelabVersion: { type: 'string' },
    os: {
      type: 'object',
      required: ['fireOs', 'android', 'sdk'],
      additionalProperties: false,
      properties: {
        fireOs: { $ref: '#/$defs/factString' },
        android: { $ref: '#/$defs/factString' },
        sdk: { $ref: '#/$defs/factInteger' },
        build: { $ref: '#/$defs/factString' },
      },
    },
    cpu: {
      type: 'object',
      required: ['abis'],
      additionalProperties: false,
      properties: {
        abis: { $ref: '#/$defs/factStrings' },
        soc: { $ref: '#/$defs/factString' },
        cores: { $ref: '#/$defs/factInteger' },
        maxGHz: { $ref: '#/$defs/factNumber' },
      },
    },
    memory: {
      type: 'object',
      required: ['totalMB', 'availIdleMB', 'availWebViewMB', 'appBudgetMB', 'appLimitMB'],
      additionalProperties: false,
      properties: {
        totalMB: { $ref: '#/$defs/factNumber' },
        availIdleMB: { $ref: '#/$defs/factNumber' },
        availWebViewMB: { $ref: '#/$defs/factNumber' },
        knownGoodMB: { $ref: '#/$defs/factNumber' },
        lowestAvailMB: { $ref: '#/$defs/factNumber' },
        appBudgetMB: { $ref: '#/$defs/factNumber' },
        appLimitMB: { $ref: '#/$defs/factNumber' },
        lowRam: { $ref: '#/$defs/factBoolean' },
      },
    },
    gpu: {
      type: 'object',
      required: ['renderer', 'speedFactor'],
      additionalProperties: false,
      properties: {
        renderer: { $ref: '#/$defs/factString' },
        vendor: { $ref: '#/$defs/factString' },
        speedFactor: { $ref: '#/$defs/factNumber' },
      },
    },
    webgl: {
      type: 'object',
      required: ['webgl1', 'webgl2', 'maxTextureSize', 'maxRenderbufferSize', 'extensions', 'compressed'],
      additionalProperties: false,
      properties: {
        webgl1: { $ref: '#/$defs/factBoolean' },
        webgl2: { $ref: '#/$defs/factBoolean' },
        maxTextureSize: { $ref: '#/$defs/factInteger' },
        maxRenderbufferSize: { $ref: '#/$defs/factInteger' },
        extensions: { $ref: '#/$defs/factStrings' },
        compressed: fact({ type: 'array', items: { enum: ['etc1', 'etc2', 'astc', 's3tc', 'pvrtc', 'bptc', 'rgtc', 'atc'] } }),
        floatRender: { $ref: '#/$defs/factBoolean' },
        mediumpFp16: { $ref: '#/$defs/factBoolean' },
      },
    },
    webview: {
      type: 'object',
      required: ['version', 'major'],
      additionalProperties: false,
      properties: {
        version: { $ref: '#/$defs/factString' },
        major: { $ref: '#/$defs/factInteger' },
        package: { $ref: '#/$defs/factString' },
      },
    },
    media: {
      type: 'object',
      required: ['decoders'],
      additionalProperties: false,
      properties: {
        decoders: fact({ type: 'array', items: { $ref: '#/$defs/decoder' } }),
        streamOkMbps: { $ref: '#/$defs/factNumber' },
        streamStallMbps: { $ref: '#/$defs/factNumber' },
        canPlay: fact({ type: 'object', additionalProperties: { type: 'string' } }),
      },
    },
    display: {
      type: 'object',
      required: ['width', 'height'],
      additionalProperties: false,
      properties: {
        width: { $ref: '#/$defs/factInteger' },
        height: { $ref: '#/$defs/factInteger' },
        density: { $ref: '#/$defs/factInteger' },
      },
    },
    references: { type: 'array', items: { $ref: '#/$defs/reference' } },
    notes: { type: 'array', items: { type: 'string' } },
  },
  $defs: {
    source: { enum: [...FACT_SOURCES] },
    factString: fact({ type: 'string' }),
    factNumber: fact({ type: 'number', minimum: 0 }),
    factInteger: fact({ type: 'integer', minimum: 0 }),
    factBoolean: fact({ type: 'boolean' }),
    factStrings: fact({ type: 'array', items: { type: 'string' } }),
    decoder: {
      type: 'object',
      required: ['codec', 'supported'],
      additionalProperties: false,
      properties: {
        codec: { enum: [...VIDEO_CODECS] },
        supported: { type: ['boolean', 'null'] },
        maxWidth: { type: 'integer', minimum: 1 },
        maxHeight: { type: 'integer', minimum: 1 },
        maxFps: { type: 'number', minimum: 1 },
        profiles: { type: 'array', items: { type: 'string' } },
        maxLevel: { type: 'string', pattern: '^\\d(\\.\\d)?$' },
      },
    },
    reference: {
      type: 'object',
      required: ['app'],
      additionalProperties: false,
      properties: {
        app: { type: 'string' },
        scene: { type: 'string' },
        tier: { type: 'string' },
        resolution: { type: 'string' },
        fps: numberOrRange,
        appPssMB: numberOrRange,
        rendererPssMB: numberOrRange,
        memAvailableMB: numberOrRange,
        drawCalls: { type: 'integer', minimum: 0 },
        triangles: { type: 'integer', minimum: 0 },
        date: { type: 'string' },
        note: { type: 'string' },
      },
    },
  },
};

// ---------- a small JSON Schema validator ----------

export type SchemaError = { path: string; message: string };

const typeOf = (v: unknown): string => (v === null ? 'null' : Array.isArray(v) ? 'array' : Number.isInteger(v) ? 'integer' : typeof v);
const isType = (v: unknown, t: string): boolean => {
  const actual = typeOf(v);
  return t === actual || (t === 'number' && actual === 'integer');
};

/**
 * Validates `data` against `schema`. Supports the keywords PROFILE_SCHEMA uses:
 * type, enum, const, properties, required, additionalProperties, items,
 * minItems, maxItems, minimum, maximum, minLength, pattern, anyOf, $ref (#/$defs/...).
 */
export function validateSchema(schema: Schema, data: unknown, root: Schema = schema, path = '$'): SchemaError[] {
  const errs: SchemaError[] = [];
  const s = schema;
  if (typeof s.$ref === 'string') {
    const m = /^#\/\$defs\/(.+)$/.exec(s.$ref);
    const target = m ? ((root.$defs as Record<string, Schema> | undefined)?.[m[1] as string]) : undefined;
    if (!target) return [{ path, message: `unresolvable $ref ${s.$ref}` }];
    return validateSchema(target, data, root, path);
  }
  if (Array.isArray(s.anyOf)) {
    const branches = (s.anyOf as Schema[]).map((b) => validateSchema(b, data, root, path));
    if (!branches.some((b) => b.length === 0)) {
      // Report the branch whose type matched (its errors are deeper), not "expected null".
      const typed = branches.filter((b) => !b.some((e) => e.path === path && e.message.startsWith('expected ')));
      const pool = typed.length ? typed : branches;
      const best = pool.reduce((a, b) => (b.length < a.length ? b : a));
      errs.push(...(best.length ? best : [{ path, message: 'matches none of the allowed shapes' }]));
    }
    return errs;
  }
  if (s.type !== undefined) {
    const types = Array.isArray(s.type) ? (s.type as string[]) : [s.type as string];
    if (!types.some((t) => isType(data, t))) return [{ path, message: `expected ${types.join(' or ')}, got ${typeOf(data)}` }];
  }
  if ('const' in s && data !== s.const) errs.push({ path, message: `must be ${JSON.stringify(s.const)}` });
  if (Array.isArray(s.enum) && !(s.enum as unknown[]).includes(data)) errs.push({ path, message: `must be one of ${(s.enum as unknown[]).map((e) => JSON.stringify(e)).join(', ')}` });
  if (typeof data === 'number') {
    if (typeof s.minimum === 'number' && data < s.minimum) errs.push({ path, message: `must be >= ${s.minimum}` });
    if (typeof s.maximum === 'number' && data > s.maximum) errs.push({ path, message: `must be <= ${s.maximum}` });
  }
  if (typeof data === 'string') {
    if (typeof s.minLength === 'number' && data.length < s.minLength) errs.push({ path, message: `must have at least ${s.minLength} characters` });
    if (typeof s.pattern === 'string' && !new RegExp(s.pattern).test(data)) errs.push({ path, message: `must match ${s.pattern}` });
  }
  if (Array.isArray(data)) {
    if (typeof s.minItems === 'number' && data.length < s.minItems) errs.push({ path, message: `needs at least ${s.minItems} items` });
    if (typeof s.maxItems === 'number' && data.length > s.maxItems) errs.push({ path, message: `allows at most ${s.maxItems} items` });
    if (s.items && typeof s.items === 'object') data.forEach((item, i) => errs.push(...validateSchema(s.items as Schema, item, root, `${path}[${i}]`)));
  }
  if (data && typeof data === 'object' && !Array.isArray(data)) {
    const obj = data as Record<string, unknown>;
    const props = (s.properties ?? {}) as Record<string, Schema>;
    for (const k of (s.required as string[] | undefined) ?? []) if (!(k in obj)) errs.push({ path: `${path}.${k}`, message: 'is required' });
    for (const [k, v] of Object.entries(obj)) {
      if (props[k]) errs.push(...validateSchema(props[k] as Schema, v, root, `${path}.${k}`));
      else if (s.additionalProperties === false) errs.push({ path: `${path}.${k}`, message: 'is not a known field' });
      else if (s.additionalProperties && typeof s.additionalProperties === 'object') errs.push(...validateSchema(s.additionalProperties as Schema, v, root, `${path}.${k}`));
    }
  }
  return errs;
}

/** Walks every { value, source } fact in a profile. */
function* facts(node: unknown, path: string): Generator<{ path: string; value: unknown; source: unknown }> {
  if (!node || typeof node !== 'object' || Array.isArray(node)) return;
  const o = node as Record<string, unknown>;
  if ('source' in o && 'value' in o && Object.keys(o).every((k) => k === 'value' || k === 'source' || k === 'note')) {
    yield { path, value: o.value, source: o.source };
    return;
  }
  for (const [k, v] of Object.entries(o)) if (k !== 'references') yield* facts(v, `${path}.${k}`);
}

/**
 * Validates a profile: the schema, plus the rules the schema can't express
 * (unknown facts have a null value, known facts don't; budget <= limit).
 */
export function validateProfile(data: unknown): SchemaError[] {
  const errs = validateSchema(PROFILE_SCHEMA, data);
  if (errs.length) return errs;
  for (const f of facts(data, '$')) {
    if (f.source === 'unknown' && f.value !== null) errs.push({ path: f.path, message: 'source is "unknown" but a value is given' });
    if (f.source !== 'unknown' && f.value === null) errs.push({ path: f.path, message: `value is null but source is "${String(f.source)}" (use "unknown")` });
  }
  const p = data as DeviceProfile;
  const b = p.memory.appBudgetMB.value;
  const l = p.memory.appLimitMB.value;
  if (b !== null && l !== null && b > l) errs.push({ path: '$.memory.appBudgetMB', message: `budget ${b} MB is above the limit ${l} MB` });
  return errs;
}

export function assertProfile(data: unknown, label = 'profile'): DeviceProfile {
  const errs = validateProfile(data);
  if (errs.length) throw new Error(`${label} is not a valid FireLab device profile:\n${errs.slice(0, 12).map((e) => `  ${e.path} ${e.message}`).join('\n')}`);
  return data as DeviceProfile;
}
