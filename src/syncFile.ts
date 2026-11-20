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
import { basename, resolve } from 'node:path';
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

export function parseSyncFile(text: string): SyncFile {
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
  return { ...(audio ? { audio } : {}), points: parseSyncPoints(parts.join(',')) };
}

export function formatSyncFile(tabPath: string, audio: string, points: SyncPoint[], notes = new Map<number, string>()): string {
  const lines = [
    `# Sync points for ${basename(tabPath)}, made by "tabhop sync".`,
    '# Each line is: bar = time in the recording (a fraction is a position in the bar).',
    '# Fix or add points by hand if you like. render, info and frame use this file',
    '# whenever they play the recording below; --no-sync ignores it.',
    `audio: ${resolve(audio)}`,
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
