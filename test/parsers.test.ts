import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { nameChord } from '../src/chords.ts';
import { assignFingers } from '../src/fingering.ts';
import { loadSong } from '../src/load.ts';
import { tuningLabel } from '../src/model.ts';
import { parseAsciiTab, parseTime } from '../src/parsers/asciiTab.ts';
import { playbackOrder, scoreToSong, loadScore } from '../src/parsers/guitarPro.ts';

const fixture = (name: string) => new URL(`./${name}`, import.meta.url);

test('ASCII: bar timing with leading dash, 4 columns per beat', () => {
  const song = parseAsciiTab(`bpm: 120
e|----------------|
B|----------------|
G|----------------|
D|----------------|
A|----------------|
E|-0---0-0-0---0--|`);
  // 120 bpm => 0.5 s per beat; notes at beats 0, 1, 1.5, 2, 3
  assert.deepEqual(song.notes.map((n) => n.time), [0, 0.5, 0.75, 1, 1.5]);
  assert.ok(song.notes.every((n) => n.string === 5 && n.fret === 0));
  assert.equal(song.bars.length, 1);
});

test('ASCII: techniques, multi-digit frets and bends', () => {
  const song = parseAsciiTab(`e|-12h14p12--10b12-7/9-x-|
B|-----------------------|
G|-----------------------|
D|-----------------------|
A|-----------------------|
E|-----------------------|`);
  const ns = song.notes;
  assert.deepEqual(ns.map((n) => n.fret), [12, 14, 12, 10, 7, 9, 0]);
  assert.equal(ns[1].technique, 'hammer');
  assert.equal(ns[2].technique, 'pull');
  assert.equal(ns[3].bend, 2);
  assert.equal(ns[5].technique, 'slide');
  assert.equal(ns[6].dead, true);
});

test('ASCII: real-world tab with drop-D labels, chord line, repeat and pull-off', () => {
  const song = parseAsciiTab(readFileSync(fixture('fixture-loose-header.txt'), 'utf8'));
  assert.deepEqual(song.tuning, [62, 57, 53, 48, 43, 38]);
  assert.equal(song.bars.length, 2 * 2 + 1); // two bars repeated twice + one bar
  assert.equal(song.sections[0].text, 'Verse');
  assert.deepEqual(song.chords.map((c) => c.text), ['D5', 'F5']);
  assert.equal(song.chords[1].time, song.bars[1]);
  const pull = song.notes.find((n) => n.technique === 'pull');
  assert.equal(pull?.fret, 12);
  assert.equal(pull?.string, 1);
});

test('ASCII: grid timing ignores bar widths', () => {
  const song = parseAsciiTab(`bpm: 60
grid: 2
e|0-0-|0-0-0-|
B|----|------|
G|----|------|
D|----|------|
A|----|------|
E|----|------|`);
  assert.deepEqual(song.notes.map((n) => n.time), [0, 1, 2, 3, 4]);
});

test('chord naming', () => {
  assert.equal(nameChord([40, 47, 52]), 'E5');
  assert.equal(nameChord([48, 52, 55, 60]), 'C');
  assert.equal(nameChord([45, 52, 57, 60, 64]), 'Am');
  assert.equal(nameChord([52, 55, 60]), 'C/E');
  assert.equal(nameChord([40]), null);
});

test('fingering: power chords use index on the root', () => {
  const song = parseAsciiTab(`e|----------|
B|----------|
G|----------|
D|-----5--7-|
A|--2--5--7-|
E|--0--3--5-|`);
  assignFingers(song.notes);
  const at = (fret: number, string: number) => song.notes.find((n) => n.fret === fret && n.string === string)!.finger;
  assert.equal(at(0, 5), 0);
  assert.equal(at(3, 5), 1);
  assert.equal(at(5, 4), 3);
  assert.equal(at(5, 5), 1);
  assert.equal(at(7, 3), 3);
});

test('Guitar Pro: repeats are expanded and techniques imported', () => {
  const tex = String.raw`\tempo 120
\ts (4 4) 0.6.1 | \ro 3.6.1 | \rc 3 5.6{h}.1 | 7.1{b (0 4)}.1`;
  const score = loadScore(new TextEncoder().encode(tex), '.atex');
  assert.deepEqual(playbackOrder(score), [0, 1, 2, 1, 2, 1, 2, 3]);
  const song = scoreToSong(score);
  assert.equal(song.notes.length, 8);
  assert.equal(song.notes[7].time, 14); // 7 bars of 2 s
  assert.equal(song.notes[7].string, 0);
  assert.equal(song.notes[7].bend, 2);
});

test('example files load', () => {
  for (const f of ['../examples/demo-riff.txt', '../examples/demo-lead.atex']) {
    const { song } = loadSong(new URL(f, import.meta.url).pathname.replace(/^\/([A-Z]:)/, '$1'));
    assert.ok(song.notes.length > 10);
    assert.ok(song.notes.every((n) => n.finger !== undefined));
  }
});

test('ASCII: end-of-line comments in the header, without breaking sharps or paths', () => {
  const tab = (header: string) =>
    parseAsciiTab(`${header}\ne|----|\nB|----|\nG|----|\nD|-2--|\nA|-2--|\nE|-0--|`);
  const song = tab('bpm: 90   # check against the recording\ntuning: C# F# B E G# C#  // half step up\naudio: song#2.mp3 # comment');
  assert.equal(song.bpm, 90);
  assert.deepEqual(song.tuning, [61, 56, 52, 47, 42, 37]);
  assert.equal(song.audio?.path, 'song#2.mp3');
});

test('ASCII: invalid timing values in the header are rejected with the line number', () => {
  const tab = (header: string) =>
    parseAsciiTab(`title: x\n${header}\ne|----|\nB|----|\nG|----|\nD|-2--|\nA|-2--|\nE|-0--|`);
  assert.throws(() => tab('bpm: fast'), /^Error: Line 2: bpm must be a positive number, got "fast"/);
  assert.throws(() => tab('tempo: 0'), /Line 2: tempo must be a positive number/);
  assert.throws(() => tab('bpm: -90'), /bpm must be a positive number/);
  assert.throws(() => tab('time: 4/0'), /Line 2: Invalid time signature "4\/0"/);
  assert.throws(() => tab('time: 0/4'), /Invalid time signature "0\/4"/);
  assert.throws(() => tab('grid: 0'), /grid must be a positive number/);
  assert.throws(() => tab('quantize: none'), /quantize must be a positive number/);
  // Values with units or decimals are still fine.
  assert.equal(tab('bpm: 92.5 bpm').bpm, 92.5);
});

test('ASCII: invalid values in a mid-song directive are rejected too', () => {
  const sys = 'e|----|\nB|----|\nG|----|\nD|-2--|\nA|-2--|\nE|-0--|';
  assert.throws(() => parseAsciiTab(`${sys}\n\nbpm: ?\n${sys}`), /Line 8: bpm must be a positive number/);
});

test('parseTime: seconds, m:ss and h:mm:ss, including negative times', () => {
  assert.equal(parseTime('58.76'), 58.76);
  assert.equal(parseTime(' 0:58.76 '), 58.76);
  assert.equal(parseTime('1:02:03'), 3723);
  assert.equal(parseTime('.5'), 0.5);
  assert.equal(parseTime('-1.548'), -1.548);
  // The sign applies to the whole time, not just the minutes.
  assert.equal(parseTime('-0:01.548'), -1.548);
  assert.equal(parseTime('-1:30'), -90);
  assert.equal(parseTime('+2'), 2);
  for (const bad of ['', 'abc', '1:-2', '--1', '1::2', '1.5:30', '1:2:3:4', '-']) {
    assert.throws(() => parseTime(bad), /Invalid time/, `"${bad}" should be rejected`);
  }
});

test('ASCII: a negative audioStart in the header', () => {
  const song = parseAsciiTab(`audio: a.mp3\naudioStart: -0:01.5\ne|----|\nB|----|\nG|----|\nD|-2--|\nA|-2--|\nE|-0--|`);
  assert.deepEqual(song.audio, { path: 'a.mp3', start: -1.5 });
});

test('Guitar Pro: firstSound is the first note in any track, including drums', () => {
  const atex = (s: string) => scoreToSong(loadScore(new TextEncoder().encode(s), '.atex'));
  // Bar 1 is silent everywhere: the music starts at bar 2 (2 s at 120 bpm).
  assert.equal(atex(String.raw`\tempo 120 \track "Gtr" r.1 | 0.6.4 0.6.4 0.6.4 0.6.4`).firstSound, 2);
  // Only the guitar rests in bar 1; the drums play from the start.
  const drums = String.raw`\tempo 120 \track "Gtr" r.1 | 0.6.4 \track "Drums" \instrument percussion \articulation defaults r.2 (KickHit).4 r.4 | r.1`;
  assert.equal(atex(drums).firstSound, 1);
  assert.equal(atex(drums).notes[0].time, 2);
  // A pickup: the first note comes on beat 4 of bar 1.
  assert.equal(atex(String.raw`\tempo 120 r.2 r.4 3.6.4 | 0.6.1`).firstSound, 1.5);
});

test('Guitar Pro: crash, china and splash hits in any drum track become sync landmarks', () => {
  const atex = (s: string) => scoreToSong(loadScore(new TextEncoder().encode(s), '.atex'));
  const song = atex(String.raw`\tempo 120 \track "Gtr" 0.6.1 | 0.6.1 | 0.6.1
    \track "Drums" \instrument percussion \articulation defaults
    (CrashHighHit KickHit).4 (HiHatClosed).4 (RideMiddle).4 (SplashHit).4 | (ChinaHit).2 (CrashMediumHit).2 | r.1`);
  // Hi-hat and ride are left out: they're too frequent and too soft to line up with.
  assert.deepEqual(song.cymbals, [0, 1.5, 2, 3]);
  assert.equal(atex(String.raw`\tempo 120 0.6.1`).cymbals, undefined);
});

// The README's header examples are what people copy, so they must parse as written.
test('README tab examples parse as written', () => {
  const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
  const blocks = [...readme.matchAll(/^```[^\r\n]*\r?\n([\s\S]*?)^```/gm)].map((m) => m[1]);

  const tabExample = blocks.find((b) => b.includes('tuning:') && b.includes('e|'));
  assert.ok(tabExample, 'README has a tab example');
  const song = parseAsciiTab(tabExample);
  assert.deepEqual(song.tuning, [64, 59, 55, 50, 45, 40]);
  assert.equal(song.bars.length, 4); // 2 bars, x2
  assert.deepEqual(song.chords.map((c) => c.text), ['E5', 'G5']);
  assert.ok(song.notes.some((n) => n.palmMute));

  const audioExample = blocks.find((b) => b.includes('audio:') && b.includes('audioStart:'));
  assert.ok(audioExample, 'README has an audio header example');
  const withAudio = parseAsciiTab(`${audioExample}\ne|----|\nB|----|\nG|----|\nD|-2--|\nA|-2--|\nE|-0--|`);
  assert.equal(withAudio.audio?.path, 'D:\\MUSIX\\song.mp3');
  assert.equal(withAudio.audio?.start, 58.762);
});

test('unsupported formats are rejected with a clear message before reading the file', () => {
  // The paths don't exist: the extension check must happen first.
  assert.throws(() => loadSong('missing/tab-screenshot.png'), /"\.png" files aren't supported\.\nImages and PDFs/);
  assert.throws(() => loadSong('missing/song.docx'), (e: Error) => /"\.docx"/.test(e.message) && !/Images/.test(e.message));
  assert.throws(() => loadSong('missing/song'), /has no file extension/);
  assert.throws(() => loadSong('missing/song.mp3'), /Supported formats: \.gp .*\.txt \.tab/);
});

test('tuning label: standard is hidden, shifted/drop/custom tunings are named', () => {
  assert.equal(tuningLabel([64, 59, 55, 50, 45, 40]), undefined);
  assert.equal(tuningLabel([64, 59, 55, 50, 45, 40, 35]), undefined);
  assert.deepEqual(tuningLabel([63, 58, 54, 49, 44, 39]), { name: 'Eb Standard', notes: 'Eb Ab Db Gb Bb Eb' });
  assert.equal(tuningLabel([62, 57, 53, 48, 43, 38])?.name, 'D Standard');
  assert.equal(tuningLabel([64, 59, 55, 50, 45, 38])?.name, 'Drop D');
  assert.equal(tuningLabel([63, 58, 54, 49, 44, 37])?.name, 'Drop C#');
  assert.equal(tuningLabel([42, 37, 32, 27])?.name, 'Eb Standard'); // bass
  assert.deepEqual(tuningLabel([62, 59, 55, 50, 43, 38]), { name: 'D G D G B D', notes: 'D G D G B D' });
});
