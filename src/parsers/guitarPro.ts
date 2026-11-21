/**
 * Guitar Pro / MusicXML / alphaTex import via alphaTab.
 * These formats carry exact rhythm, tempo, repeats and techniques, so they give
 * the most faithful charts.
 */
import * as alphaTab from '@coderline/alphatab';
import type { Finger, Marker, Note, Song } from '../model.ts';

type Score = alphaTab.model.Score;
type Track = alphaTab.model.Track;
type ATNote = alphaTab.model.Note;

const TICKS_PER_QUARTER = 960;

/** General MIDI drum notes of crash-like cymbals: crash 1, china, splash, crash 2. */
const CYMBAL_NOTES = new Set([49, 52, 55, 57]);

function isCymbal(track: Track, n: ATNote): boolean {
  // Indices past the track's own list are GP7 ids, which equal the MIDI note for plain hits.
  const midi = track.percussionArticulations[n.percussionArticulation]?.outputMidiNumber ?? n.percussionArticulation;
  return CYMBAL_NOTES.has(midi);
}

export function loadScore(bytes: Uint8Array, ext: string): Score {
  const settings = new alphaTab.Settings();
  if (ext === '.atex' || ext === '.alphatex' || ext === '.tex') {
    const importer = new alphaTab.importer.AlphaTexImporter();
    importer.initFromString(new TextDecoder().decode(bytes), settings);
    return importer.readScore();
  }
  return alphaTab.importer.ScoreLoader.loadScoreFromBytes(bytes, settings);
}

export function isGuitarTrack(track: Track): boolean {
  const staff = track.staves[0];
  return !!staff && !staff.isPercussion && staff.tuning.length >= 4;
}

export function describeTracks(score: Score): string[] {
  return score.tracks.map((t, i) => {
    const staff = t.staves[0];
    const kind = staff?.isPercussion ? 'drums' : `${staff?.tuning.length ?? 0} strings`;
    return `${i}: ${t.name || '(unnamed)'} [${kind}]`;
  });
}

/** Returns the master bar indices in playback order with repeats/alternate endings expanded. */
export function playbackOrder(score: Score): number[] {
  const mbs = score.masterBars;
  const order: number[] = [];
  const jumps = new Map<number, number>();
  let i = 0;
  let start = 0;
  let pass = 1;
  while (i < mbs.length && order.length < 20000) {
    const mb = mbs[i];
    if (mb.isRepeatStart && i !== start) {
      start = i;
      pass = 1;
    }
    if (mb.alternateEndings && !(mb.alternateEndings & (1 << (pass - 1)))) {
      i++;
      continue;
    }
    order.push(i);
    if (mb.repeatCount > 0) {
      const done = jumps.get(i) ?? 0;
      if (done < mb.repeatCount - 1) {
        jumps.set(i, done + 1);
        pass++;
        i = start;
        continue;
      }
      jumps.delete(i);
      start = i + 1;
      pass = 1;
    }
    i++;
  }
  return order;
}

export function scoreToSong(score: Score, trackIndex?: number): Song {
  const count = score.tracks.length;
  if (trackIndex !== undefined && (trackIndex < 0 || trackIndex >= count)) {
    const which = count === 1 ? 'track 0' : `tracks 0-${count - 1}`;
    throw new Error(`There is no track ${trackIndex}: this file has ${which} (see "info")`);
  }
  const track =
    trackIndex !== undefined ? score.tracks[trackIndex] : score.tracks.find(isGuitarTrack);
  if (!track) throw new Error('No guitar track found in file');
  if (!isGuitarTrack(track)) throw new Error(`Track ${trackIndex} is not a stringed instrument track`);
  const staff = track.staves[0];
  const stringCount = staff.tuning.length;

  const notes: Note[] = [];
  const bars: number[] = [];
  const beats: number[] = [];
  const sections: Marker[] = [];
  const chords: Marker[] = [];

  let bpm = score.tempo;
  let barStartSec = 0;
  const lastOnString = new Map<number, Note>();
  const atByModel = new Map<Note, ATNote>();
  let firstSound: number | undefined;
  // Keyed to the microsecond so hits in several tracks or voices count once; the value stays exact.
  const cymbals = new Map<number, number>();
  const drumTracks = score.tracks.filter((t) => t.staves[0]?.isPercussion);

  for (const mbIndex of playbackOrder(score)) {
    const mb = score.masterBars[mbIndex];
    const barTicks = mb.calculateDuration();
    // Tempo segments inside this bar.
    const segs: { tick: number; bpm: number }[] = [{ tick: 0, bpm }];
    for (const a of mb.tempoAutomations ?? []) {
      const tick = Math.round(a.ratioPosition * barTicks);
      if (tick === 0) segs[0].bpm = a.value;
      else segs.push({ tick, bpm: a.value });
    }
    segs.sort((a, b) => a.tick - b.tick);
    const startSec = barStartSec;
    const sec = (tick: number): number => {
      let s = startSec;
      for (let k = 0; k < segs.length; k++) {
        const from = segs[k].tick;
        const to = k + 1 < segs.length ? Math.min(segs[k + 1].tick, tick) : tick;
        if (to <= from) break;
        s += ((to - from) / TICKS_PER_QUARTER) * (60 / segs[k].bpm);
      }
      return s;
    };

    bars.push(startSec);
    const beatTicks = (TICKS_PER_QUARTER * 4) / mb.timeSignatureDenominator;
    for (let b = 0; b * beatTicks < barTicks - 1; b++) beats.push(sec(b * beatTicks));
    if (mb.section?.text) sections.push({ time: startSec, text: mb.section.text });

    if (firstSound === undefined) {
      // Earliest note in any track/staff, drums included.
      for (const tr of score.tracks) {
        for (const st of tr.staves) {
          for (const voice of st.bars[mbIndex]?.voices ?? []) {
            const b = voice.beats.find((x) => !x.isRest && x.notes.length > 0);
            if (b) firstSound = Math.min(firstSound ?? Infinity, sec(b.playbackStart));
          }
        }
      }
    }

    for (const tr of drumTracks) {
      for (const st of tr.staves) {
        for (const voice of st.bars[mbIndex]?.voices ?? []) {
          for (const b of voice.beats) {
            if (b.isRest || !b.notes.some((n) => isCymbal(tr, n))) continue;
            const t = sec(b.playbackStart);
            cymbals.set(Math.round(t * 1e6), t);
          }
        }
      }
    }

    const bar = staff.bars[mbIndex];
    for (const voice of bar?.voices ?? []) {
      for (const beat of voice.beats) {
        if (beat.isRest || beat.notes.length === 0) continue;
        const t0 = sec(beat.playbackStart);
        const t1 = sec(beat.playbackStart + beat.playbackDuration);
        const chordName = beat.chord?.name;
        if (chordName) chords.push({ time: t0, text: chordName });
        for (const n of beat.notes) {
          const stringIdx = stringCount - n.string;
          if (n.isTieDestination) {
            const prev = lastOnString.get(stringIdx);
            if (prev) prev.duration = t1 - prev.time;
            continue;
          }
          const note: Note = { time: t0, duration: Math.max(0.01, t1 - t0), string: stringIdx, fret: n.fret };
          if (n.leftHandFinger >= 1 && n.leftHandFinger <= 4) note.finger = n.leftHandFinger as Finger;
          if (n.isHammerPullDestination) {
            const origin = n.hammerPullOrigin;
            note.technique = origin && origin.fret > n.fret ? 'pull' : 'hammer';
          }
          const prev = lastOnString.get(stringIdx);
          const prevAt = prev ? atByModel.get(prev) : undefined;
          if (prevAt && (prevAt.slideOutType === 1 || prevAt.slideOutType === 2)) note.technique = 'slide';
          if (n.isLeftHandTapped || beat.tap) note.technique = 'tap';
          if (n.hasBend) {
            const max = Math.max(...n.bendPoints!.map((p) => p.value));
            if (max > 0) note.bend = max / 2;
          }
          if (n.isPalmMute) note.palmMute = true;
          if (n.isDead) note.dead = true;
          if (n.harmonicType !== 0) note.harmonic = true;
          if (n.vibrato !== 0 || beat.vibrato !== 0) note.vibrato = true;
          if (n.slideOutType === 3 || n.slideOutType === 6) note.slideOut = 'up';
          if (n.slideOutType === 4 || n.slideOutType === 5) note.slideOut = 'down';
          notes.push(note);
          atByModel.set(note, n);
          lastOnString.set(stringIdx, note);
        }
      }
    }
    const lastSeg = segs[segs.length - 1];
    bpm = lastSeg.bpm;
    barStartSec = sec(barTicks);
  }

  notes.sort((a, b) => a.time - b.time || a.string - b.string);
  const firstMb = score.masterBars[0];
  return {
    title: score.title || 'Untitled',
    artist: score.artist || '',
    tuning: [...staff.tuning],
    notes,
    bars,
    beats,
    sections,
    chords,
    end: barStartSec,
    bpm: score.tempo,
    beatsPerBar: firstMb?.timeSignatureNumerator ?? 4,
    firstSound,
    ...(cymbals.size ? { cymbals: [...cymbals.values()].sort((a, b) => a - b) } : {}),
  };
}
