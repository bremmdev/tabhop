/**
 * Sync points saved next to the tab ("song.gp5.sync.txt"), written by
 * `tabhop sync` and read by render/info/frame whenever the same recording is
 * used. Plain text, so it's easy to fix a point by hand:
 *
 *   # comments
 *   audio: D:\Music\song.mp3
 *   2 = 0:00.062
 *   110 = 2:43.120   # a note
 */
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { parseTime } from './parsers/asciiTab.ts';
import { parseSyncPoints, type SyncPoint } from './sync.ts';

export interface SyncFile {
  audio?: string;
  points: SyncPoint[];
}

export function syncFilePath(tabPath: string): string {
  return `${tabPath}.sync.txt`;
}

/** "2:43.120" */
export function clock(t: number): string {
  const sign = t < 0 ? '-' : '';
  const a = Math.abs(t);
  return `${sign}${Math.floor(a / 60)}:${(a % 60).toFixed(3).padStart(6, '0')}`;
}

/**
 * Reads a sync file. With `path`, a relative "audio:" path is taken relative to
 * the file's folder (as "audio:" in a text tab is relative to the tab).
 */
export function parseSyncFile(text: string, path?: string): SyncFile {
  let audio: string | undefined;
  const parts: string[] = [];
  text.split(/\r?\n/).forEach((raw, i) => {
    // "#" starts a comment at the start of a line or after a space, so "song#2.mp3" still works.
    const line = raw.replace(/(^|\s)#.*$/, '').trim();
    if (!line) return;
    const a = /^audio\s*:\s*(.+)$/i.exec(line);
    if (a) audio = a[1].trim();
    else if (/^\d+(\.\d+)?\s*=/.test(line)) {
      // Checked here so the error says which line.
      try {
        parseTime(line.slice(line.indexOf('=') + 1).trim());
      } catch (e) {
        throw new Error(`Line ${i + 1}: ${(e as Error).message}`);
      }
      parts.push(line);
    } else throw new Error(`Line ${i + 1}: expected "bar = time" or "audio: <file>", got "${line}"`);
  });
  if (!parts.length) throw new Error('No sync points in the file');
  if (audio && path) audio = resolve(dirname(path), audio);
  return { ...(audio ? { audio } : {}), points: parseSyncPoints(parts.join(',')) };
}

/**
 * The recording as written in a sync file at `syncPath`: relative to it when the
 * recording is in that folder or below (so the folder can move as a whole),
 * otherwise the full path (a music folder elsewhere stays put when the tabs move).
 */
function audioForFile(syncPath: string, audio: string): string {
  const full = resolve(audio);
  const rel = relative(dirname(resolve(syncPath)), full);
  const inside = rel !== '' && !isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`);
  return inside ? rel.split(sep).join('/') : full;
}

export function formatSyncFile(
  file: { path: string; tab: string; audio: string },
  points: SyncPoint[],
  notes = new Map<number, string>(),
): string {
  const lines = [
    `# Sync points for ${basename(file.tab)}, made by "tabhop sync".`,
    '# Each line is: bar = time in the recording (a fraction is a position in the bar).',
    '# Fix or add points by hand if you like. render, info and frame use this file',
    '# whenever they play the recording below; --no-sync ignores it.',
    `audio: ${audioForFile(file.path, file.audio)}`,
    '',
    ...points.map((p) => {
      const line = `${p.bar} = ${clock(p.time)}`;
      const note = notes.get(p.bar);
      return note ? `${line.padEnd(16)}  # ${note}` : line;
    }),
  ];
  return `${lines.join('\n')}\n`;
}

/** Whether two paths name the same file (case-insensitive on Windows). */
export function samePath(a: string, b: string): boolean {
  const [x, y] = [resolve(a), resolve(b)];
  return process.platform === 'win32' ? x.toLowerCase() === y.toLowerCase() : x === y;
}

/** Whether two paths end in the same file name (case-insensitive on Windows). */
export function sameFileName(a: string, b: string): boolean {
  const [x, y] = [basename(a), basename(b)];
  return process.platform === 'win32' ? x.toLowerCase() === y.toLowerCase() : x === y;
}
