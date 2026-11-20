import { parseArgs } from 'node:util';

export const OPTIONS = {
  speed: { type: 'string', short: 's', default: '100' },
  out: { type: 'string', short: 'o' },
  track: { type: 'string', short: 't' },
  bars: { type: 'string', short: 'b' },
  fps: { type: 'string', default: '60' },
  size: { type: 'string', default: '1920x1080' },
  zoom: { type: 'string', default: '1' },
  'note-shape': { type: 'string', default: 'tile' },
  'count-in': { type: 'string', default: '1' },
  'no-chords': { type: 'boolean', default: false },
  encoder: { type: 'string', default: 'libx264' },
  crf: { type: 'string', default: '18' },
  workers: { type: 'string' },
  audio: { type: 'string' },
  'audio-start': { type: 'string' },
  sync: { type: 'string' },
  'no-sync': { type: 'boolean', default: false },
  'no-audio': { type: 'boolean', default: false },
  at: { type: 'string' },
  help: { type: 'boolean', short: 'h' },
} as const;

type OptionName = keyof typeof OPTIONS;

const SHORT = new Map<string, OptionName>(
  (Object.entries(OPTIONS) as [OptionName, { short?: string }][]).flatMap(([name, o]) => (o.short ? [[o.short, name]] : [])),
);

/** "-1.5", "-.5", "-0:01.5" — a value, not an option. */
const NEGATIVE_VALUE = /^-\.?\d/;

/**
 * node's parseArgs refuses "--audio-start -1.5" as ambiguous (the value looks
 * like an option), so join negative values to their option: "--audio-start=-1.5".
 */
function joinNegativeValues(argv: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--') {
      out.push(...argv.slice(i));
      break;
    }
    const name = arg.startsWith('--') ? (arg.slice(2) as OptionName) : /^-\w$/.test(arg) ? SHORT.get(arg[1]) : undefined;
    const next = argv[i + 1];
    if (name && OPTIONS[name]?.type === 'string' && next !== undefined && NEGATIVE_VALUE.test(next)) {
      out.push(`--${name}=${next}`);
      i++;
    } else out.push(arg);
  }
  return out;
}

export function parseCliArgs(argv: string[]) {
  return parseArgs({ args: joinNegativeValues(argv), allowPositionals: true, options: OPTIONS });
}
