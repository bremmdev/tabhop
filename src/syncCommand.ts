/** `tabhop sync`: suggest sync points from the recording, report how sure they are, save them. */
import { existsSync, renameSync, writeFileSync } from 'node:fs';
import { envelope, findAttacks, readHighBand } from './audio.ts';
import { autoSync, checkCymbals, type AutoSyncResult, type SectionCheck } from './autosync.ts';
import type { Song } from './model.ts';
import type { SyncPoint } from './sync.ts';
import { clock, formatSyncFile, syncFilePath } from './syncFile.ts';

export interface SyncCommandOptions {
  tabPath: string;
  audioPath: string;
  /** Points the user already knows (--sync), kept exactly. */
  pinned?: SyncPoint[];
  /** Where to save; defaults to next to the tab. */
  out?: string;
}

const pct = (f: number) => `${(Math.abs(f - 1) * 100).toFixed(1)}% ${f >= 1 ? 'faster' : 'slower'}`;

/** What to say about a section, or undefined if it looks fine. */
function concern(c: SectionCheck): string | undefined {
  if (c.alsoFits !== undefined) return `listen: the cymbals also fit ${Math.abs(c.alsoFits).toFixed(2)} s ${c.alsoFits > 0 ? 'later' : 'earlier'}`;
  if (c.cymbals === 0) return 'no cymbals: the tempo around it is carried over';
  if (c.medianError !== undefined && c.medianError > 0.04 && c.cymbals >= 3) return "listen: few of the tab's cymbals are heard near where they should be";
  return undefined;
}

export function formatReport(r: AutoSyncResult, tabPath: string, audioPath: string, savedTo: string): string {
  const out: string[] = [];
  out.push(`${r.cymbals} crash cymbals in the tab; ${r.matched} line up with a crash in the recording (within 50 ms).`);
  out.push('');
  const [a, b] = [r.points[0], r.points[r.points.length - 1]];
  out.push(`${r.points.length} sync points, from bar ${a.bar} at ${clock(a.time)} to bar ${b.bar} at ${clock(b.time)}.`);
  out.push('');
  out.push('Check (fitted on half the cymbals, checked on the other half):');
  const rows = r.checks.map((c) => [
    `  bars ${c.fromBar}-${c.toBar}${c.label ? ` ${c.label}` : ''}`,
    pct(c.tempoFactor),
    c.cymbals ? `${c.heard} of ${c.cymbals} cymbals heard` : '',
    c.medianError !== undefined ? `${Math.round(c.medianError * 1000)} ms` : '',
    concern(c) ? `<- ${concern(c)}` : '',
  ]);
  const width = (i: number) => Math.max(...rows.map((row) => row[i].length));
  for (const row of rows) out.push(row.map((cell, i) => (i < row.length - 1 ? cell.padEnd(width(i)) : cell)).join('  ').trimEnd());
  out.push('  (tempo: the recording compared with the tab; ms: median distance to the nearest crash)');

  for (const run of r.unheardRuns) {
    const bars = run.fromBar === run.toBar ? `Bar ${run.fromBar}` : `Bars ${run.fromBar}-${run.toBar}`;
    out.push('');
    out.push(`${bars}: the tab's run of ${run.cymbals} cymbals isn't in the recording, so it was left out.`);
    out.push(`  The band may play this part differently (or hold it longer). If the video is off after it,`);
    out.push(`  pin the next bar by ear and run sync again: --sync "${run.toBar + 1}=m:ss"`);
  }
  if (r.recordingEndsInBar !== undefined) {
    out.push('');
    out.push(`The recording ends in bar ${r.recordingEndsInBar} of the tab.`);
  }
  out.push('');
  out.push(`Saved to ${savedTo}`);
  out.push(`render, info and frame use it whenever they play ${audioPath}. To fix a section by ear,`);
  out.push(`edit the file, or pin points and run sync again: tabhop sync "${tabPath}" --audio "${audioPath}" --sync "bar=m:ss, ..."`);
  return out.join('\n');
}

export async function syncCommand(song: Song, opts: SyncCommandOptions): Promise<string> {
  checkCymbals(song);
  const env = envelope(await readHighBand(opts.audioPath));
  const duration = env.length / 1000;
  if (duration < 1) throw new Error(`"${opts.audioPath}" is too short to line up with`);
  const result = autoSync(song, findAttacks(env), duration, { pinned: opts.pinned });

  const notes = new Map<number, string>();
  for (const p of opts.pinned ?? []) notes.set(p.bar, 'pinned');
  for (const run of result.unheardRuns) {
    const after = result.points.find((p) => p.bar > run.toBar);
    if (after && !notes.has(after.bar)) notes.set(after.bar, `check: after the cymbal run in bars ${run.fromBar}-${run.toBar}`);
  }
  for (const c of result.checks) {
    const msg = concern(c);
    const first = result.points.find((p) => p.bar >= c.fromBar && p.bar <= c.toBar + 1);
    if (msg?.startsWith('listen') && first && !notes.has(first.bar)) notes.set(first.bar, `check bars ${c.fromBar}-${c.toBar}: ${msg.slice('listen: '.length)}`);
  }

  const path = opts.out ?? syncFilePath(opts.tabPath);
  // Keep the previous file (maybe edited by hand) rather than losing it.
  if (existsSync(path)) renameSync(path, `${path}.bak`);
  writeFileSync(path, formatSyncFile({ path, tab: opts.tabPath, audio: opts.audioPath }, result.points, notes));
  return formatReport(result, opts.tabPath, opts.audioPath, path);
}
