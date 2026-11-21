/**
 * Plain-text (ASCII) tab import.
 *
 * ASCII tabs don't encode rhythm, so timing is reconstructed from character
 * spacing. Two modes:
 *  - `timing: bar`  (default) every bar (between `|` lines) is one measure;
 *                   notes are placed by column and snapped to a grid (`quantize`).
 *  - `timing: grid` every `grid` characters is one beat, bar lines are ignored
 *                   for timing. Best for tabs with perfectly regular spacing.
 *
 * See README.md for the full header reference.
 */
import { STANDARD_TUNING, STANDARD_TUNINGS, parseNoteName, type Marker, type Note, type Song, type Technique } from '../model.ts';
import { TempoMap } from '../tempo.ts';

interface Settings {
  title: string;
  artist: string;
  bpm: number;
  beatsPerBar: number;
  beatUnit: number;
  timing: 'bar' | 'grid';
  grid: number;
  quantize: number;
  tuning?: number[];
  audio?: string;
  audioStart?: number;
}

interface TabEvent {
  col: number;
  string: number;
  fret: number;
  technique?: Technique;
  bend?: number;
  harmonic?: boolean;
  vibrato?: boolean;
  slideOut?: 'up' | 'down';
  dead?: boolean;
  palmMute?: boolean;
}

interface Segment {
  start: number; // first content column
  end: number; // exclusive
  events: TabEvent[];
}

interface System {
  segments: Segment[];
  chords: { col: number; text: string }[];
  repeat: number;
  section?: string;
  /** Directives (bpm/time changes) that apply from the start of this system. */
  changes: Partial<Settings>;
}

const ALLOWED = /^[-0-9|hpbrsxXtTvV\/\\~()<>\[\].*=^ ]*$/;
const PREFIX = /^\s*(?:([A-Ga-g][#b]?)\s*)?(?:\|\|?|:)?/;
const CHORD_TOKEN = /^\(?[A-G][#b]?(?:m|maj|min|dim|aug|sus|add|M)?\d*(?:sus\d|add\d+|b5|#5|\+)?(?:\/[A-G][#b]?)?\)?\*?$/;

const DEFAULTS: Settings = {
  title: 'Untitled',
  artist: '',
  bpm: 100,
  beatsPerBar: 4,
  beatUnit: 4,
  timing: 'bar',
  grid: 4,
  quantize: 16,
};

/**
 * Strips an end-of-line comment ("bpm: 120   # check this"). The marker needs
 * whitespace on both sides so sharps ("C# F#") and paths ("song#2.mp3") survive.
 */
function stripComment(line: string): string {
  return line.replace(/\s+(?:#|\/\/)(?:\s.*)?$/, '');
}

function parseDirective(line: string): [string, string] | null {
  const m = /^\s*([A-Za-z]+)\s*[:=]\s*(.+?)\s*$/.exec(stripComment(line));
  if (!m) return null;
  const key = m[1].toLowerCase();
  const known = ['title', 'artist', 'bpm', 'tempo', 'time', 'timing', 'grid', 'quantize', 'tuning', 'audio', 'audiostart'];
  return known.includes(key) ? [key, m[2]] : null;
}

/** Timing values must be positive: 0 or NaN would silently turn every note time into NaN/Infinity. */
function positive(key: string, value: string): number {
  const n = Number.parseFloat(value);
  if (!(n > 0) || !Number.isFinite(n)) throw new Error(`${key} must be a positive number, got "${value}"`);
  return n;
}

function applyDirective(target: Partial<Settings>, key: string, value: string): void {
  switch (key) {
    case 'title':
      target.title = value;
      break;
    case 'artist':
      target.artist = value;
      break;
    case 'bpm':
    case 'tempo':
      target.bpm = positive(key, value);
      break;
    case 'time': {
      const m = /(\d+)\s*\/\s*(\d+)/.exec(value);
      if (!m || Number(m[1]) === 0 || Number(m[2]) === 0) throw new Error(`Invalid time signature "${value}" (use e.g. 4/4)`);
      target.beatsPerBar = Number(m[1]);
      target.beatUnit = Number(m[2]);
      break;
    }
    case 'timing':
      if (value !== 'bar' && value !== 'grid') throw new Error(`timing must be "bar" or "grid"`);
      target.timing = value;
      break;
    case 'grid':
      target.grid = positive(key, value);
      target.timing = 'grid';
      break;
    case 'quantize':
      target.quantize = positive(key, value);
      break;
    case 'audio':
      target.audio = value.replace(/^["']|["']$/g, '');
      break;
    case 'audiostart':
      target.audioStart = parseTime(value);
      break;
    case 'tuning':
      target.tuning = parseTuning(value);
      break;
  }
}

const NAMED_TUNINGS: Record<string, number[]> = {
  standard: [64, 59, 55, 50, 45, 40],
  'drop d': [64, 59, 55, 50, 45, 38],
  'eb': [63, 58, 54, 49, 44, 39],
  'half step down': [63, 58, 54, 49, 44, 39],
  'd standard': [62, 57, 53, 48, 43, 38],
  'drop c': [62, 57, 53, 48, 43, 36],
  'drop c#': [63, 58, 54, 49, 44, 37],
  'open g': [62, 59, 55, 50, 43, 38],
  'open d': [62, 57, 54, 50, 45, 38],
  bass: [43, 38, 33, 28],
  '7 string': [64, 59, 55, 50, 45, 40, 35],
};

/** Picks the octave for each string name closest to (preferably below) the standard pitch. */
function namesToMidi(namesHighToLow: string[]): number[] {
  const ref = STANDARD_TUNINGS[namesHighToLow.length];
  if (!ref) throw new Error(`Unsupported string count: ${namesHighToLow.length}`);
  return namesHighToLow.map((name, i) => {
    const pc = parseNoteName(name.replace(/\d/g, '')) % 12;
    let midi = ref[i] + ((pc - (ref[i] % 12) + 12) % 12);
    if (midi > ref[i] + 4) midi -= 12;
    return midi;
  });
}

/** Tuning header: named ("drop d") or note names from LOW to HIGH ("D A D G B E"). */
function parseTuning(value: string): number[] {
  const named = NAMED_TUNINGS[value.toLowerCase()];
  if (named) return named;
  const names = value.match(/[A-Ga-g][#b]?\d?/g);
  if (!names || names.length < 4) throw new Error(`Invalid tuning "${value}"`);
  if (names.every((n) => /\d/.test(n))) return names.map(parseNoteName).reverse();
  return namesToMidi([...names].reverse());
}

/** Splits a raw line into [prefixLength, content, trailingAnnotation, label] if it is a tab line. */
function asTabLine(raw: string): { prefix: number; content: string; trailing: string; label?: string } | null {
  const line = raw.replace(/\t/g, '    ').replace(/\s+$/, '');
  const pm = PREFIX.exec(line)!;
  let content = line.slice(pm[0].length);
  let trailing = '';
  const lastBar = content.lastIndexOf('|');
  const after = content.slice(lastBar + 1);
  // Text after the final bar line ("| x2", "|  repeat") is an annotation, not tab.
  if (lastBar >= 0 && after.trim() !== '' && (!ALLOWED.test(after) || /\s/.test(after))) {
    trailing = content.slice(lastBar + 1);
    content = content.slice(0, lastBar + 1);
  }
  const dashes = (content.match(/-/g) ?? []).length;
  if (dashes < 3 || !ALLOWED.test(content)) return null;
  // Require that dashes dominate so prose lines with a few hyphens are not picked up.
  if (dashes < content.replace(/\s/g, '').length * 0.2) return null;
  return { prefix: pm[0].length, content, trailing, label: pm[1] };
}

function tokenize(content: string, stringIdx: number): TabEvent[] {
  const events: TabEvent[] = [];
  let pendingTech: Technique | undefined;
  let harmonicOpen = false;
  let c = 0;
  while (c < content.length) {
    const ch = content[c];
    if (/\d/.test(ch)) {
      let digits = ch;
      if (ch !== '0' && /\d/.test(content[c + 1] ?? '') && Number(ch + content[c + 1]) <= 24) digits += content[c + 1];
      const ev: TabEvent = { col: c, string: stringIdx, fret: Number(digits) };
      if (pendingTech) ev.technique = pendingTech;
      if (harmonicOpen) ev.harmonic = true;
      pendingTech = undefined;
      c += digits.length;
      // Bends (7b9, 7b, 7b9r7) — the target/release frets are not new notes.
      if (content[c] === 'b' || content[c] === 'B') {
        c++;
        const tm = /^\d{1,2}/.exec(content.slice(c));
        ev.bend = tm ? Math.max(1, Number(tm[0]) - ev.fret) : 2;
        if (tm) c += tm[0].length;
        const rm = /^[rR]\d{0,2}/.exec(content.slice(c));
        if (rm) c += rm[0].length;
      }
      if (content[c] === '>' || content[c] === ']') {
        harmonicOpen = false;
        c++;
      }
      if (content[c] === '~' || content[c] === 'v' || content[c] === 'V') ev.vibrato = true;
      // "7\--|" or "7/--": a slide out of the note that doesn't land on another note.
      if ((content[c] === '\\' || content[c] === '/') && !/^-?\d/.test(content.slice(c + 1))) {
        ev.slideOut = content[c] === '/' ? 'up' : 'down';
        c++;
      }
      events.push(ev);
      continue;
    }
    if (ch === 'x' || ch === 'X') events.push({ col: c, string: stringIdx, fret: 0, dead: true });
    else if (ch === 'h' || ch === 'H') pendingTech = 'hammer';
    else if (ch === 'p' || ch === 'P') pendingTech = 'pull';
    else if (ch === '/' || ch === '\\' || ch === 's' || ch === 'S') pendingTech = 'slide';
    else if (ch === 't' || ch === 'T') pendingTech = 'tap';
    else if (ch === '<' || ch === '[') harmonicOpen = true;
    else if (ch === '-' || ch === '|') {
      // A dash between a technique letter and its target note is fine ("5h-7"), so keep pendingTech.
    }
    c++;
  }
  return events;
}

function findPalmMuteSpans(line: string | undefined, prefix: number): [number, number][] {
  if (!line) return [];
  const spans: [number, number][] = [];
  const re = /P\.?\s?M\.?[-.|_ ]*/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(line))) {
    const end = m.index + m[0].replace(/\s+$/, '').length;
    spans.push([m.index - prefix, end - prefix]);
  }
  return spans;
}

function isPalmMuteLine(line: string | undefined): boolean {
  return !!line && /P\.?\s?M\.?/i.test(line) && !asTabLine(line);
}

function chordTokens(line: string | undefined, prefix: number): { col: number; text: string }[] | null {
  if (!line || !line.trim() || asTabLine(line) || isPalmMuteLine(line)) return null;
  const out: { col: number; text: string }[] = [];
  const re = /\S+/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(line))) {
    if (!CHORD_TOKEN.test(m[0])) return null;
    out.push({ col: m.index - prefix, text: m[0].replace(/[()*]/g, '') });
  }
  return out.length ? out : null;
}

/**
 * Seconds from "58.76", "0:58.76" or "1:02:03". A leading "-" negates the whole
 * time ("-0:01.5" is -1.5 s), for tabs whose bar 1 starts before the recording does.
 */
export function parseTime(value: string): number {
  const v = value.trim();
  const sign = v.startsWith('-') ? -1 : 1;
  const parts = v.replace(/^[-+]/, '').split(':');
  const valid =
    parts.length <= 3 &&
    parts.slice(0, -1).every((p) => /^\d+$/.test(p)) &&
    /^(?:\d+(?:\.\d*)?|\.\d+)$/.test(parts[parts.length - 1]);
  if (!valid) throw new Error(`Invalid time "${value}" (use seconds or m:ss, e.g. 58.76 or -0:01.5)`);
  return sign * parts.reduce((acc, p) => acc * 60 + Number(p), 0);
}

export function parseAsciiTab(text: string): Song {
  const lines = text.split(/\r?\n/);
  const settings: Settings = { ...DEFAULTS };
  const systems: System[] = [];
  let pendingSection: string | undefined;
  let pendingChanges: Partial<Settings> = {};
  let stringCount = 0;
  let labelTuning: number[] | undefined;
  let headerDone = false;

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    if (/^\s*(#|\/\/)/.test(raw)) continue;
    const directive = parseDirective(raw);
    if (directive && !asTabLine(raw)) {
      try {
        applyDirective(headerDone ? pendingChanges : settings, directive[0], directive[1]);
      } catch (e) {
        throw new Error(`Line ${i + 1}: ${(e as Error).message}`);
      }
      continue;
    }
    const sec = /^\s*\[([^\]]+)\]\s*$/.exec(raw);
    if (sec) {
      pendingSection = sec[1].trim();
      continue;
    }
    const first = asTabLine(raw);
    if (!first) continue;

    // Collect the contiguous block of tab lines.
    const block = [first];
    const rawBlock = [raw];
    while (i + 1 < lines.length) {
      const next = asTabLine(lines[i + 1]);
      if (!next) break;
      block.push(next);
      rawBlock.push(lines[i + 1]);
      i++;
    }
    if (block.length < 4) continue; // stray line that happened to look like tab
    headerDone = true;
    if (!stringCount) {
      stringCount = block.length;
      const labels = block.map((b) => b.label);
      if (labels.every(Boolean)) {
        try {
          labelTuning = namesToMidi(labels as string[]);
        } catch {
          labelTuning = undefined;
        }
      }
    }
    if (block.length !== stringCount) {
      throw new Error(
        `Tab system near line ${i + 1} has ${block.length} strings, expected ${stringCount}. ` +
          'Make sure every system has the same number of lines and no stray lines in between.',
      );
    }

    const startLine = i - block.length + 1;
    const prefix = block[0].prefix;
    const above1 = lines[startLine - 1];
    const above2 = lines[startLine - 2];
    const below = lines[i + 1];
    const chords = chordTokens(above1, prefix) ?? (isPalmMuteLine(above1) ? chordTokens(above2, prefix) : null) ?? [];
    const pmSpans = [
      ...(isPalmMuteLine(above1) ? findPalmMuteSpans(above1, prefix) : []),
      ...(isPalmMuteLine(above2) ? findPalmMuteSpans(above2, prefix) : []),
      ...(isPalmMuteLine(below) ? findPalmMuteSpans(below, prefix) : []),
    ];

    // Re-align each line to the first line's prefix so columns line up across strings.
    const contents = block.map((b) => ' '.repeat(Math.max(0, b.prefix - prefix)) + b.content);
    const width = Math.max(...contents.map((c) => c.length));
    const padded = contents.map((c) => c.padEnd(width, '-'));

    // Bar lines: a column where most strings have '|'.
    const barCols: number[] = [];
    for (let c = 0; c < width; c++) {
      const count = padded.filter((l) => l[c] === '|').length;
      if (count >= Math.ceil(stringCount / 2)) barCols.push(c);
    }
    const cleaned = padded.map((l) => l.split('').map((ch, c) => (barCols.includes(c) ? '-' : ch)).join(''));
    const events = cleaned.flatMap((l, s) => tokenize(l, s));
    for (const ev of events) {
      if (pmSpans.some(([a, b]) => ev.col >= a && ev.col < b)) ev.palmMute = true;
    }
    // Chord names are often written a column or two off: snap them to the nearest strum.
    const onsetCols = [...new Set(events.map((e) => e.col))];
    for (const ch of chords) {
      // A label sitting on a bar line belongs to the next bar; prefer strums at/after the label.
      const at = ch.col + 0.5;
      const dist = (c: number) => (c >= ch.col ? c - ch.col : (ch.col - c) * 1.5);
      const near = onsetCols.filter((c) => Math.abs(c - ch.col) <= 3 && !barCols.some((b) => (b - c) * (b - at) < 0));
      if (near.length) ch.col = near.sort((a, b) => dist(a) - dist(b))[0];
    }

    const bounds = [-1, ...barCols, width].filter((v, k, arr) => k === 0 || v !== arr[k - 1]);
    const segments: Segment[] = [];
    for (let k = 0; k + 1 < bounds.length; k++) {
      const start = bounds[k] + 1;
      const end = bounds[k + 1];
      if (end - start < 1) continue;
      const segEvents = events.filter((e) => e.col >= start && e.col < end);
      const empty = cleaned.every((l) => /^[- ]*$/.test(l.slice(start, end)));
      // Skip trailing filler after the last bar line.
      if (k === bounds.length - 2 && segEvents.length === 0 && end - start < 3) continue;
      if (empty && end - start < 3) continue;
      segments.push({ start, end, events: segEvents });
    }
    if (segments.length === 0) continue;

    let repeat = 1;
    const annot = [...block.map((b) => b.trailing), below && !asTabLine(below) ? below : ''].join(' ');
    const rm = /(?:^|\s|\()[xX]\s*(\d+)|(\d+)\s*[xX](?:\s|\)|$)/.exec(annot);
    if (rm) repeat = Math.min(32, Number(rm[1] ?? rm[2]));

    systems.push({ segments, chords, repeat, section: pendingSection, changes: pendingChanges });
    pendingSection = undefined;
    pendingChanges = {};
  }

  if (systems.length === 0) throw new Error('No tab found. Expected lines like "e|---3---|".');

  const tuning = settings.tuning ?? labelTuning ?? STANDARD_TUNINGS[stringCount];
  if (!tuning || tuning.length !== stringCount) {
    throw new Error(`Tuning has ${tuning?.length} strings but the tab has ${stringCount}`);
  }

  // Leading padding: most bars start with one dash before the first note ("|-3---5--").
  const leadCounts = new Map<number, number>();
  for (const sys of systems) {
    for (const seg of sys.segments) {
      if (!seg.events.length) continue;
      const lead = Math.min(...seg.events.map((e) => e.col)) - seg.start;
      if (lead <= 2) leadCounts.set(lead, (leadCounts.get(lead) ?? 0) + 1);
    }
  }
  const globalLead = [...leadCounts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 0;

  const tempo = new TempoMap(settings.bpm);
  let cur = { ...settings };
  let beat = 0;
  const bars: number[] = [];
  const beats: number[] = [];
  const sections: Marker[] = [];
  const chords: Marker[] = [];
  /** `barBeats`: the length of a bar where the note is, the longest it can ring. */
  const raw: (TabEvent & { beat: number; barBeats: number })[] = [];

  for (const sys of systems) {
    cur = { ...cur, ...sys.changes };
    if (sys.changes.bpm) tempo.set(beat, sys.changes.bpm);
    if (sys.section) sections.push({ time: tempo.toSeconds(beat), text: sys.section });
    const beatsPerBar = cur.beatsPerBar; // counted in `beatUnit` notes; bpm refers to the same unit
    const step = cur.beatUnit / cur.quantize; // quantization step in beats

    for (let r = 0; r < sys.repeat; r++) {
      if (cur.timing === 'grid') {
        // Global column timing: count content columns, bar lines are zero-width.
        const sysStart = beat;
        let colOffset = 0;
        const colBeat = (seg: Segment, col: number) => sysStart + (colOffset + col - seg.start) / cur.grid;
        for (const seg of sys.segments) {
          const barStart = colBeat(seg, seg.start);
          bars.push(barStart);
          const segBeats = (seg.end - seg.start) / cur.grid;
          for (let b = 0; b < segBeats - 1e-6; b++) beats.push(barStart + b);
          for (const ev of seg.events) raw.push({ ...ev, beat: colBeat(seg, ev.col), barBeats: beatsPerBar });
          for (const ch of sys.chords) {
            if (ch.col >= seg.start && ch.col < seg.end) chords.push({ time: colBeat(seg, ch.col), text: ch.text });
          }
          colOffset += seg.end - seg.start;
        }
        beat = sysStart + colOffset / cur.grid;
      } else {
        for (const seg of sys.segments) {
          const width = seg.end - seg.start;
          const exact = width / beatsPerBar;
          let cpb = Math.abs(exact - Math.round(exact)) < 0.3 ? Math.max(1, Math.round(exact)) : exact;
          const toBeat = (col: number, fit: number) => {
            const pos = Math.max(0, col - seg.start - globalLead) / fit;
            return Math.round(pos / step) * step;
          };
          const lastCol = Math.max(seg.start, ...seg.events.map((e) => e.col));
          if (toBeat(lastCol, cpb) >= beatsPerBar) cpb = width / beatsPerBar; // spacing too irregular: fall back to proportional
          bars.push(beat);
          for (let b = 0; b < beatsPerBar; b++) beats.push(beat + b);
          for (const ev of seg.events) raw.push({ ...ev, beat: beat + Math.min(beatsPerBar - step, toBeat(ev.col, cpb)), barBeats: beatsPerBar });
          for (const ch of sys.chords) {
            if (ch.col >= seg.start - 1 && ch.col < seg.end) {
              chords.push({ time: beat + Math.min(beatsPerBar - step, toBeat(Math.max(ch.col, seg.start), cpb)), text: ch.text });
            }
          }
          beat += beatsPerBar;
        }
      }
    }
  }
  const endBeat = beat;

  // Convert to seconds; duration lasts until the next onset, capped at one bar.
  raw.sort((a, b) => a.beat - b.beat || a.string - b.string);
  const onsets = [...new Set(raw.map((e) => e.beat))].sort((a, b) => a - b);
  const notes: Note[] = raw.map((e) => {
    const nextOnset = onsets.find((o) => o > e.beat + 1e-6) ?? endBeat;
    const endBeatOfNote = Math.min(nextOnset, e.beat + e.barBeats);
    const time = tempo.toSeconds(e.beat);
    const note: Note = {
      time,
      duration: Math.max(0.01, tempo.toSeconds(endBeatOfNote) - time),
      string: e.string,
      fret: e.fret,
    };
    if (e.technique) note.technique = e.technique;
    if (e.bend) note.bend = e.bend;
    if (e.harmonic) note.harmonic = true;
    if (e.vibrato) note.vibrato = true;
    if (e.slideOut) note.slideOut = e.slideOut;
    if (e.dead) note.dead = true;
    if (e.palmMute) note.palmMute = true;
    return note;
  });

  return {
    audio: settings.audio ? { path: settings.audio, start: settings.audioStart ?? 0 } : undefined,
    title: settings.title,
    artist: settings.artist,
    tuning,
    notes,
    bars: bars.map((b) => tempo.toSeconds(b)),
    beats: beats.map((b) => tempo.toSeconds(b)),
    sections,
    chords: chords.map((c) => ({ time: tempo.toSeconds(c.time), text: c.text })),
    end: tempo.toSeconds(endBeat),
    bpm: settings.bpm,
    beatsPerBar: settings.beatsPerBar,
  };
}
