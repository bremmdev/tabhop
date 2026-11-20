/** Converts musical positions (in beats) to seconds, honouring tempo changes. */
export class TempoMap {
  private points: { beat: number; bpm: number; sec: number }[] = [];

  constructor(initialBpm: number) {
    this.points.push({ beat: 0, bpm: initialBpm, sec: 0 });
  }

  /** Register a tempo change. Changes must be added in increasing beat order. */
  set(beat: number, bpm: number): void {
    const last = this.points[this.points.length - 1];
    if (beat < last.beat) throw new Error('Tempo changes must be added in order');
    if (beat === last.beat) {
      last.bpm = bpm;
      return;
    }
    const sec = last.sec + ((beat - last.beat) * 60) / last.bpm;
    this.points.push({ beat, bpm, sec });
  }

  toSeconds(beat: number): number {
    let p = this.points[0];
    for (const q of this.points) {
      if (q.beat <= beat) p = q;
      else break;
    }
    return p.sec + ((beat - p.beat) * 60) / p.bpm;
  }

  bpmAt(beat: number): number {
    let bpm = this.points[0].bpm;
    for (const q of this.points) {
      if (q.beat <= beat) bpm = q.bpm;
      else break;
    }
    return bpm;
  }
}
