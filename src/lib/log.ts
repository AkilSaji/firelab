/**
 * Logging goes to stderr only: in `firelab mcp` (stdio) stdout belongs to the
 * MCP protocol and a stray console.log would corrupt it.
 */
type Level = 'debug' | 'info' | 'warn' | 'error';
const order: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };
let threshold: number = order[(process.env.FIRELAB_LOG as Level) ?? 'info'] ?? order.info;

export function setLogLevel(level: Level | 'silent'): void {
  threshold = level === 'silent' ? Infinity : order[level];
}

function write(level: Level, args: unknown[]): void {
  if (order[level] < threshold) return;
  const text = args.map((a) => (a instanceof Error ? a.message : typeof a === 'string' ? a : JSON.stringify(a))).join(' ');
  process.stderr.write(`[firelab] ${level === 'info' ? '' : `${level}: `}${text}\n`);
}

export const log = {
  debug: (...a: unknown[]) => write('debug', a),
  info: (...a: unknown[]) => write('info', a),
  warn: (...a: unknown[]) => write('warn', a),
  error: (...a: unknown[]) => write('error', a),
};
