import { createCanvas, type Canvas, type SKRSContext2D } from '@napi-rs/canvas';
import { ballY, type Geometry, type Timeline } from '../layout.ts';
import { tuningLabel, type Marker, type Note, type Song } from '../model.ts';
import { FONT, fingerColor, theme } from './theme.ts';

type Ctx = SKRSContext2D;

export const NOTE_SHAPES = ['tile', 'round', 'hex', 'outline'] as const;
export type NoteShape = (typeof NOTE_SHAPES)[number];

export interface RenderOptions {
  speed: number; // 1 = 100%
  videoDuration: number; // seconds of output video
  noteShape?: NoteShape;
}

interface ChordLabel extends Marker {
  width: number;
}

/** Draws one frame of the chart for a given song time. */
export class Renderer {
  private readonly song: Song;
  private readonly g: Geometry;
  private readonly tl: Timeline;
  private readonly opts: RenderOptions;
  private readonly chordLabels: ChordLabel[];
  private readonly static: Canvas;
  private readonly minimap: { future: Canvas; past: Canvas; x: number; y: number; w: number; h: number };
  private readonly tuning: ReturnType<typeof tuningLabel>;

  constructor(song: Song, g: Geometry, tl: Timeline, opts: RenderOptions) {
    this.song = song;
    this.g = g;
    this.tl = tl;
    this.opts = opts;
    this.static = this.buildStaticLayer();
    this.chordLabels = this.layoutChordLabels();
    this.minimap = this.buildMinimap();
    this.tuning = tuningLabel(song.tuning);
  }

  private x(t: number, now: number): number {
    return this.g.ballX + (t - now) * this.g.pxPerSec;
  }

  draw(ctx: Ctx, now: number, videoTime: number): void {
    const { g } = this;
    ctx.drawImage(this.static, 0, 0);
    this.drawGrid(ctx, now);
    this.drawStrings(ctx);
    this.drawMarkers(ctx, now);
    this.drawPalmMutes(ctx, now);
    this.drawNotes(ctx, now);
    this.drawTrail(ctx, now);
    this.drawHitFlashes(ctx, now);
    this.drawBall(ctx, now);
    this.drawCountIn(ctx, now);
    this.drawHud(ctx, now, videoTime);

    const fadeIn = Math.max(0, 1 - videoTime / 0.4);
    const fadeOut = Math.max(0, 1 - (this.opts.videoDuration - videoTime) / 0.6);
    const fade = Math.max(fadeIn, fadeOut);
    if (fade > 0) {
      ctx.fillStyle = `rgba(0,0,0,${fade})`;
      ctx.fillRect(0, 0, g.width, g.height);
    }
  }

  // ---------------------------------------------------------------- static

  private buildStaticLayer(): Canvas {
    const { g } = this;
    const c = createCanvas(g.width, g.height);
    const ctx = c.getContext('2d');
    const bg = ctx.createLinearGradient(0, 0, 0, g.height);
    bg.addColorStop(0, theme.bgTop);
    bg.addColorStop(0.55, theme.bgMid);
    bg.addColorStop(1, theme.bgBottom);
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, g.width, g.height);

    // Warm light falling on the board around the ball column.
    const glow = ctx.createRadialGradient(g.ballX, g.boardTop, 0, g.ballX, g.boardTop, g.width * 0.5);
    glow.addColorStop(0, `rgba(${theme.glow},0.10)`);
    glow.addColorStop(1, `rgba(${theme.glow},0)`);
    ctx.fillStyle = glow;
    ctx.fillRect(0, 0, g.width, g.height);

    this.drawPattern(ctx);

    // Vignette: darken the corners of the sky.
    const vig = ctx.createRadialGradient(g.width / 2, g.boardTop, g.width * 0.25, g.width / 2, g.boardTop, g.width * 0.75);
    vig.addColorStop(0, 'rgba(0,0,0,0)');
    vig.addColorStop(1, 'rgba(0,0,0,0.45)');
    ctx.fillStyle = vig;
    ctx.fillRect(0, 0, g.width, g.boardTop);

    // Fretboard.
    const board = ctx.createLinearGradient(0, g.boardTop, 0, g.boardBottom);
    board.addColorStop(0, theme.boardTop);
    board.addColorStop(1, theme.boardBottom);
    ctx.fillStyle = board;
    ctx.fillRect(0, g.boardTop, g.width, g.boardBottom - g.boardTop);
    ctx.fillStyle = theme.boardEdge;
    ctx.fillRect(0, g.boardTop, g.width, 3 * g.s);
    ctx.fillStyle = 'rgba(0,0,0,0.35)';
    ctx.fillRect(0, g.boardBottom, g.width, 6 * g.s);

    // "Now" column: a faint vertical light at the ball position.
    const now = ctx.createLinearGradient(g.ballX - 40 * g.s, 0, g.ballX + 40 * g.s, 0);
    now.addColorStop(0, `rgba(${theme.glow},0)`);
    now.addColorStop(0.5, `rgba(${theme.glow},0.07)`);
    now.addColorStop(1, `rgba(${theme.glow},0)`);
    ctx.fillStyle = now;
    ctx.fillRect(g.ballX - 40 * g.s, g.boardTop, 80 * g.s, g.boardBottom - g.boardTop);

    // Footer.
    ctx.fillStyle = 'rgba(0,0,0,0.45)';
    ctx.fillRect(0, g.footerTop, g.width, g.height - g.footerTop);
    return c;
  }

  /**
   * Faint amber pattern in the area above the board. It fades out towards the top of the
   * screen so the title area stays calm, and is strongest just above the board.
   */
  private drawPattern(ctx: Ctx): void {
    const { g } = this;
    const w = g.width;
    const h = g.boardTop;
    const c = createCanvas(w, Math.ceil(h));
    const p = c.getContext('2d');
    p.strokeStyle = `rgb(${theme.glow})`;
    p.fillStyle = `rgb(${theme.glow})`;
    p.lineWidth = 1.6 * g.s;

    switch (theme.pattern) {
      case 'waves': {
        // Layered sound waves, swelling in the middle of the screen.
        const lines = 16;
        for (let i = 0; i < lines; i++) {
          const y0 = h * 0.1 + (i / (lines - 1)) * h * 0.85;
          const amp = (10 + 14 * (0.5 + 0.5 * Math.sin(i * 0.9))) * g.s;
          const freq = 2.2 + 0.6 * Math.sin(i * 1.7);
          p.beginPath();
          for (let x = 0; x <= w; x += 4 * g.s) {
            const env = Math.sin((Math.PI * x) / w);
            const y = y0 + amp * env * Math.sin((x / w) * Math.PI * 2 * freq + i * 0.55);
            if (x === 0) p.moveTo(x, y);
            else p.lineTo(x, y);
          }
          p.stroke();
        }
        break;
      }
      case 'halftone': {
        // Dot grid like a speaker grille; dots grow towards the board and the ball column.
        const step = 22 * g.s;
        for (let row = 0, y = step / 2; y < h; row++, y += step) {
          for (let x = (row % 2) * (step / 2); x < w + step; x += step) {
            const near = 1 - Math.min(1, Math.abs(x - g.ballX) / (w * 0.8));
            const r = (0.6 + 4.2 * (y / h) ** 1.4 * (0.45 + 0.55 * near)) * g.s;
            p.beginPath();
            p.arc(x, y, r, 0, Math.PI * 2);
            p.fill();
          }
        }
        break;
      }
      case 'ripples': {
        // Sound rings spreading out from where the ball bounces.
        const step = 34 * g.s;
        for (let r = step; r < w; r += step) {
          p.globalAlpha = Math.max(0, 1 - r / (w * 0.85));
          p.beginPath();
          p.arc(g.ballX, h, r, Math.PI, Math.PI * 2);
          p.stroke();
        }
        p.globalAlpha = 1;
        break;
      }
    }

    // Fade out towards the top.
    p.globalCompositeOperation = 'destination-in';
    const fade = p.createLinearGradient(0, 0, 0, h);
    fade.addColorStop(0, 'rgba(0,0,0,0)');
    fade.addColorStop(0.35, 'rgba(0,0,0,0.35)');
    fade.addColorStop(1, 'rgba(0,0,0,1)');
    p.fillStyle = fade;
    p.fillRect(0, 0, w, h);

    ctx.globalAlpha = theme.patternAlpha;
    ctx.drawImage(c, 0, 0);
    ctx.globalAlpha = 1;
  }

  private layoutChordLabels(): ChordLabel[] {
    const ctx = createCanvas(10, 10).getContext('2d');
    ctx.font = this.chordFont();
    const out: ChordLabel[] = [];
    let lastRight = -Infinity;
    for (const c of [...this.song.chords].sort((a, b) => a.time - b.time)) {
      const width = ctx.measureText(c.text).width;
      const left = c.time * this.g.pxPerSec - this.g.noteR;
      if (left < lastRight + 14 * this.g.s) continue; // would overlap the previous label
      out.push({ ...c, width });
      lastRight = left + width;
    }
    return out;
  }

  private chordFont(): string {
    return `bold ${Math.round(54 * this.g.s)}px ${FONT}`;
  }

  private buildMinimap() {
    const { g, song } = this;
    const x = 60 * g.s;
    const w = g.width - 380 * g.s;
    const h = 34 * g.s;
    const y = g.footerTop + (g.height - g.footerTop - h) / 2;
    const span = this.tl.end - this.tl.start;
    const make = (colorFor: (n: Note) => string) => {
      const c = createCanvas(Math.ceil(w), Math.ceil(h));
      const ctx = c.getContext('2d');
      const rows = song.tuning.length;
      const rowH = h / rows;
      for (const n of song.notes) {
        ctx.fillStyle = colorFor(n);
        const nx = ((n.time - this.tl.start) / span) * w;
        const nw = Math.max(2 * g.s, (n.duration / span) * w - 1);
        ctx.fillRect(nx, n.string * rowH + rowH * 0.15, nw, Math.max(1.5, rowH * 0.7));
      }
      return c;
    };
    return {
      future: make((n) => fingerColor(n.finger)),
      past: make(() => theme.played),
      x,
      y,
      w,
      h,
    };
  }

  // ---------------------------------------------------------------- layers

  private drawGrid(ctx: Ctx, now: number): void {
    const { g, song } = this;
    const visible = (t: number) => {
      const x = this.x(t, now);
      return x > -10 && x < g.width + 10 ? x : null;
    };
    ctx.fillStyle = theme.beatLine;
    for (const b of [...this.tl.countInBeats, ...song.beats]) {
      const x = visible(b);
      if (x !== null) ctx.fillRect(Math.round(x - g.s), g.boardTop, 2 * g.s, g.boardBottom - g.boardTop);
    }
    for (const b of song.bars) {
      const x = visible(b);
      if (x === null) continue;
      ctx.fillStyle = theme.barLine;
      ctx.fillRect(Math.round(x - 1.5 * g.s), g.boardTop, 3 * g.s, g.boardBottom - g.boardTop);
    }
  }

  private drawStrings(ctx: Ctx): void {
    const { g } = this;
    const n = g.stringYs.length;
    // Amber strings: pale for the plain ones, deeper for the three lowest (wound) strings,
    // which are also clearly thicker.
    const firstWound = Math.max(0, n - 3);
    g.stringYs.forEach((y, i) => {
      const wound = i >= firstWound;
      const th = (wound ? 4.5 + (i - firstWound) * 1.25 : 1.6 + i * 0.5) * g.s;
      ctx.globalAlpha = 0.6;
      ctx.fillStyle = wound ? theme.stringThick : theme.stringThin;
      ctx.fillRect(0, y - th / 2, g.width, th);
      ctx.globalAlpha = 1;
      if (wound) {
        // Thin highlight along the top so the heavier strings read as round.
        ctx.fillStyle = 'rgba(255,255,255,0.12)';
        ctx.fillRect(0, y - th / 2, g.width, Math.max(1, th * 0.22));
      }
      ctx.fillStyle = 'rgba(0,0,0,0.3)';
      ctx.fillRect(0, y + th / 2, g.width, g.s);
    });
  }

  private drawMarkers(ctx: Ctx, now: number): void {
    const { g } = this;
    ctx.textBaseline = 'alphabetic';
    ctx.textAlign = 'left';
    ctx.font = `${Math.round(30 * g.s)}px ${FONT}`;
    ctx.fillStyle = theme.muted;
    const secs = this.song.sections;
    for (let i = 0; i < secs.length; i++) {
      // The current section's label sticks to the left edge until the next one pushes it away.
      const w = ctx.measureText(secs[i].text).width;
      let x = Math.max(this.x(secs[i].time, now) + 12 * g.s, 60 * g.s);
      if (i + 1 < secs.length) x = Math.min(x, this.x(secs[i + 1].time, now) - w - 30 * g.s);
      if (x > g.width || x + w < 0) continue;
      ctx.fillText(secs[i].text, x, g.sectionY);
    }
    ctx.font = this.chordFont();
    for (const c of this.chordLabels) {
      const x = this.x(c.time, now) - g.noteR;
      if (x > g.width || x + c.width < 0) continue;
      const passed = c.time <= now;
      ctx.fillStyle = passed ? 'rgba(255,255,255,0.45)' : theme.text;
      ctx.fillText(c.text, x, g.chordY);
    }
  }

  private drawPalmMutes(ctx: Ctx, now: number): void {
    const { g } = this;
    ctx.font = `bold ${Math.round(20 * g.s)}px ${FONT}`;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    for (const [a, b] of this.tl.pmSpans) {
      const x0 = this.x(a, now) - g.noteR;
      const x1 = Math.max(this.x(b, now), x0 + 50 * g.s);
      if (x1 < 0 || x0 > g.width) continue;
      ctx.fillStyle = 'rgba(255,255,255,0.6)';
      ctx.fillText('P.M.', x0, g.pmY);
      ctx.fillStyle = 'rgba(255,255,255,0.35)';
      for (let x = x0 + 46 * g.s; x < x1; x += 12 * g.s) ctx.fillRect(x, g.pmY - g.s, 6 * g.s, 2 * g.s);
    }
  }

  private noteGeometry(n: Note, now: number) {
    const { g } = this;
    const r = g.noteR;
    const x0 = this.x(n.time, now);
    // Only notes held for about a beat or longer get a sustain tail; it stops short of the next note.
    // Leave room for the slide-out line when there is one.
    const tail = n.duration * g.pxPerSec - 2 * r - 6 * g.s - (n.slideOut ? 2.4 * r : 0);
    const xEnd = n.duration >= 0.9 * this.tl.beatLen && tail > 0.3 * r ? x0 + tail : x0;
    return { r, x0, xEnd, y: g.stringYs[n.string] };
  }

  private drawNotes(ctx: Ctx, now: number): void {
    const { g } = this;
    const minT = now - (g.ballX + 200 * g.s) / g.pxPerSec;
    const maxT = now + (g.width - g.ballX + 100 * g.s) / g.pxPerSec;
    const visible = this.song.notes.filter((n) => n.time <= maxT && n.time + n.duration >= minT);
    // Draw connectors first so note bodies sit on top.
    for (const n of visible) this.drawConnector(ctx, n, now);
    // Lower strings first so higher-string notes overlap them (matches reading order).
    for (const n of [...visible].sort((a, b) => b.string - a.string || a.time - b.time)) this.drawNote(ctx, n, now);
  }

  private drawConnector(ctx: Ctx, n: Note, now: number): void {
    if (n.technique !== 'slide' && n.technique !== 'hammer' && n.technique !== 'pull') return;
    const prev = this.tl.prevOnString.get(n);
    if (!prev) return;
    const { g } = this;
    const a = this.noteGeometry(prev, now);
    const b = this.noteGeometry(n, now);
    ctx.strokeStyle = 'rgba(255,255,255,0.85)';
    ctx.lineWidth = 3 * g.s;
    ctx.lineCap = 'round';
    ctx.beginPath();
    if (n.technique === 'slide') {
      const up = n.fret >= prev.fret;
      const xa = a.xEnd + a.r * 0.7;
      const xb = b.x0 - b.r * 0.7;
      ctx.moveTo(xa, a.y + (up ? 0.45 : -0.45) * a.r);
      ctx.lineTo(Math.max(xa + 4 * g.s, xb), b.y + (up ? -0.45 : 0.45) * b.r);
    } else {
      const xa = a.xEnd;
      const xb = b.x0;
      const top = a.y - a.r - Math.min(26 * g.s, (xb - xa) * 0.25);
      ctx.moveTo(xa, a.y - a.r * 0.95);
      ctx.quadraticCurveTo((xa + xb) / 2, top, xb, b.y - b.r * 0.95);
    }
    ctx.stroke();
  }

  /** Outline of a note from its start (x0) to the end of its sustain (x1), centred on y. */
  private notePath(ctx: Ctx, x0: number, x1: number, y: number, r: number): void {
    switch (this.opts.noteShape ?? 'tile') {
      case 'tile':
      case 'outline':
        this.roundRect(ctx, x0 - r, y - r, x1 - x0 + 2 * r, 2 * r, r * 0.34);
        return;
      case 'hex': {
        // Flat top and bottom, pointed ends: a gem that stretches into a bar for sustains.
        const k = r * 0.52;
        ctx.beginPath();
        ctx.moveTo(x0 - r, y);
        ctx.lineTo(x0 - r + k, y - r);
        ctx.lineTo(x1 + r - k, y - r);
        ctx.lineTo(x1 + r, y);
        ctx.lineTo(x1 + r - k, y + r);
        ctx.lineTo(x0 - r + k, y + r);
        ctx.closePath();
        return;
      }
      default:
        this.pill(ctx, x0, x1, y, r);
    }
  }

  private roundRect(ctx: Ctx, x: number, y: number, w: number, h: number, rad: number): void {
    ctx.beginPath();
    ctx.moveTo(x + rad, y);
    ctx.arcTo(x + w, y, x + w, y + h, rad);
    ctx.arcTo(x + w, y + h, x, y + h, rad);
    ctx.arcTo(x, y + h, x, y, rad);
    ctx.arcTo(x, y, x + w, y, rad);
    ctx.closePath();
  }

  private pill(ctx: Ctx, x0: number, x1: number, y: number, r: number): void {
    ctx.beginPath();
    ctx.arc(x0, y, r, Math.PI / 2, (Math.PI * 3) / 2);
    ctx.lineTo(x1, y - r);
    ctx.arc(x1, y, r, -Math.PI / 2, Math.PI / 2);
    ctx.closePath();
  }

  private drawNote(ctx: Ctx, n: Note, now: number): void {
    const { g } = this;
    const { x0, xEnd, y } = this.noteGeometry(n, now);
    // Small pop when the ball lands.
    const since = now - n.time;
    const pop = since >= 0 && since < 0.18 ? 1 + 0.14 * Math.sin((since / 0.18) * Math.PI) : 1;
    const r = g.noteR * pop;
    const base = fingerColor(n.finger);
    const playedTo = since >= 0 ? Math.max(g.ballX, x0 + r) : -Infinity;
    // The "outline" note shape draws every note hollow with a coloured border.
    const hollow = this.opts.noteShape === 'outline';

    this.notePath(ctx, x0, xEnd, y, r);
    ctx.fillStyle = 'rgba(0,0,0,0.45)';
    ctx.save();
    ctx.translate(0, 3 * g.s);
    ctx.fill();
    ctx.restore();

    // Played part of the note (a sustain empties from left to right as it rings).
    const playedRight = playedTo > x0 - r ? Math.min(playedTo, xEnd + r) : x0 - r;
    const pad = 4 * g.s;

    ctx.save();
    this.notePath(ctx, x0, xEnd, y, r);
    ctx.clip();
    ctx.fillStyle = hollow ? theme.hollow : base;
    ctx.fillRect(x0 - r, y - r, xEnd - x0 + 2 * r, 2 * r);
    if (playedRight > x0 - r) {
      ctx.fillStyle = theme.playedFill;
      ctx.fillRect(x0 - r, y - r, playedRight - (x0 - r), 2 * r);
    }
    // Shading: lighter top, darker bottom.
    const shade = ctx.createLinearGradient(0, y - r, 0, y + r);
    shade.addColorStop(0, 'rgba(255,255,255,0.22)');
    shade.addColorStop(0.45, 'rgba(255,255,255,0.02)');
    shade.addColorStop(0.55, 'rgba(0,0,0,0.06)');
    shade.addColorStop(1, 'rgba(0,0,0,0.2)');
    ctx.fillStyle = shade;
    ctx.fillRect(x0 - r, y - r, xEnd - x0 + 2 * r, 2 * r);
    if (n.vibrato && xEnd > x0) this.drawVibrato(ctx, x0 + r * 1.2, xEnd + r * 0.5, y, r, hollow ? 'rgba(255,255,255,0.55)' : 'rgba(28,25,23,0.5)');
    ctx.restore();

    if (hollow && playedRight < xEnd + r) {
      // Coloured border on the part that hasn't been played yet.
      ctx.save();
      ctx.beginPath();
      ctx.rect(playedRight, y - r - pad, xEnd + r + pad - playedRight, 2 * (r + pad));
      ctx.clip();
      this.notePath(ctx, x0, xEnd, y, r - 1.75 * g.s);
      ctx.strokeStyle = base;
      ctx.lineWidth = 3.5 * g.s;
      ctx.stroke();
      ctx.restore();
    }

    if (playedRight > x0 - r) {
      // Played: a dark tile with a dimmed cream outline (and vibrato line).
      ctx.save();
      ctx.beginPath();
      ctx.rect(x0 - r - pad, y - r - pad, playedRight - (x0 - r) + pad, 2 * (r + pad));
      ctx.clip();
      this.notePath(ctx, x0, xEnd, y, r - 1.5 * g.s);
      ctx.strokeStyle = theme.playedOutline;
      ctx.lineWidth = 3 * g.s;
      ctx.stroke();
      if (n.vibrato && xEnd > x0) this.drawVibrato(ctx, x0 + r * 1.2, xEnd + r * 0.5, y, r, theme.playedOutline);
      ctx.restore();
    }

    if (n.harmonic) {
      ctx.strokeStyle = 'rgba(255,255,255,0.9)';
      ctx.lineWidth = 2.5 * g.s;
      ctx.beginPath();
      ctx.moveTo(x0, y - r * 0.92);
      ctx.lineTo(x0 + r * 0.92, y);
      ctx.lineTo(x0, y + r * 0.92);
      ctx.lineTo(x0 - r * 0.92, y);
      ctx.closePath();
      ctx.stroke();
    }

    const played = since >= 0;
    const textColor = played ? theme.playedNumber : hollow ? theme.text : (theme.fingerText[n.finger ?? 0] ?? theme.text);
    ctx.fillStyle = textColor;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const label = n.dead ? '×' : String(n.fret);
    ctx.font = `bold ${Math.round(r * (label.length > 1 ? 1.0 : 1.12))}px ${FONT}`;
    // Soft shadow under white numbers so they stay readable on the light fills.
    ctx.shadowColor = textColor === theme.text ? 'rgba(0,0,0,0.55)' : 'transparent';
    ctx.shadowBlur = 3 * g.s;
    ctx.shadowOffsetY = 1.5 * g.s;
    ctx.fillText(label, x0, y + r * 0.04);
    ctx.shadowColor = 'transparent';
    ctx.shadowOffsetY = 0;
    ctx.shadowBlur = 0;

    if (n.technique) {
      const letter = { hammer: 'H', pull: 'P', slide: 'S', tap: 'T' }[n.technique];
      this.badge(ctx, x0 - r * 0.78, y - r * 0.82, letter);
    }
    if (n.bend) this.drawBend(ctx, x0 + r * 0.65, y - r * 0.7, n.bend);
    if (n.slideOut) {
      const dir = n.slideOut === 'down' ? 1 : -1;
      const sx = xEnd + r * 1.05;
      ctx.strokeStyle = 'rgba(255,255,255,0.9)';
      ctx.lineWidth = 3.5 * g.s;
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(sx, y - dir * r * 0.45);
      ctx.lineTo(sx + r * 1.1, y + dir * r * 0.55);
      ctx.stroke();
    }
  }

  private badge(ctx: Ctx, x: number, y: number, text: string): void {
    const { g } = this;
    const br = 12 * g.s;
    ctx.fillStyle = theme.badge;
    ctx.strokeStyle = 'rgba(255,255,255,0.85)';
    ctx.lineWidth = 1.6 * g.s;
    ctx.beginPath();
    ctx.arc(x, y, br, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = theme.text;
    ctx.font = `bold ${Math.round(15 * g.s)}px ${FONT}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, x, y + g.s);
  }

  private drawBend(ctx: Ctx, x: number, y: number, semis: number): void {
    const { g } = this;
    const h = 46 * g.s;
    ctx.strokeStyle = theme.text;
    ctx.fillStyle = theme.text;
    ctx.lineWidth = 3 * g.s;
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.quadraticCurveTo(x + 18 * g.s, y - 4 * g.s, x + 20 * g.s, y - h);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(x + 20 * g.s, y - h - 9 * g.s);
    ctx.lineTo(x + 12 * g.s, y - h + 4 * g.s);
    ctx.lineTo(x + 28 * g.s, y - h + 4 * g.s);
    ctx.closePath();
    ctx.fill();
    const label = semis === 1 ? '½' : semis === 2 ? 'full' : semis % 2 === 0 ? String(semis / 2) : `${Math.floor(semis / 2)}½`;
    ctx.font = `bold ${Math.round(20 * g.s)}px ${FONT}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'bottom';
    ctx.fillText(label, x + 20 * g.s, y - h - 12 * g.s);
  }

  private drawVibrato(ctx: Ctx, x0: number, x1: number, y: number, r: number, color: string): void {
    const { g } = this;
    ctx.strokeStyle = color;
    ctx.lineWidth = 2.5 * g.s;
    ctx.beginPath();
    for (let x = x0; x <= x1; x += 2 * g.s) {
      const yy = y + Math.sin((x - x0) / (5 * g.s)) * r * 0.22;
      if (x === x0) ctx.moveTo(x, yy);
      else ctx.lineTo(x, yy);
    }
    ctx.stroke();
  }

  /** Comet tail: the ball's recent path as a tapering ribbon that fades out behind it. */
  private drawTrail(ctx: Ctx, now: number): void {
    const { g, tl } = this;
    const len = 300 * g.s;
    const steps = 48;
    const pts: { x: number; y: number; w: number }[] = [];
    for (let i = 0; i <= steps; i++) {
      const dx = (i / steps) * len;
      const t = now - dx / g.pxPerSec;
      if (t < tl.start) break;
      pts.push({ x: g.ballX - dx, y: ballY(tl, g, t), w: g.ballR * (1 - i / steps) ** 1.3 });
    }
    if (pts.length < 2) return;
    const tailX = g.ballX - len;
    // A wide soft glow, then a narrow bright core.
    this.ribbon(ctx, pts, 1, tailX, [
      [0, `rgba(${theme.glow},0.38)`],
      [0.5, `rgba(${theme.glow},0.12)`],
      [1, `rgba(${theme.glow},0)`],
    ]);
    this.ribbon(ctx, pts, 0.45, tailX, [
      [0, 'rgba(254,243,199,0.9)'],
      [0.35, 'rgba(254,243,199,0.35)'],
      [0.8, 'rgba(254,243,199,0)'],
    ]);
  }

  private ribbon(
    ctx: Ctx,
    pts: { x: number; y: number; w: number }[],
    scale: number,
    tailX: number,
    stops: [number, string][],
  ): void {
    const top: [number, number][] = [];
    const bottom: [number, number][] = [];
    for (let i = 0; i < pts.length; i++) {
      const a = pts[Math.max(0, i - 1)];
      const b = pts[Math.min(pts.length - 1, i + 1)];
      let nx = a.y - b.y;
      let ny = b.x - a.x;
      const d = Math.hypot(nx, ny) || 1;
      nx /= d;
      ny /= d;
      const w = pts[i].w * scale;
      top.push([pts[i].x + nx * w, pts[i].y + ny * w]);
      bottom.push([pts[i].x - nx * w, pts[i].y - ny * w]);
    }
    const grad = ctx.createLinearGradient(this.g.ballX, 0, tailX, 0);
    for (const [at, color] of stops) grad.addColorStop(at, color);
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.moveTo(top[0][0], top[0][1]);
    for (const [x, y] of top.slice(1)) ctx.lineTo(x, y);
    for (const [x, y] of bottom.reverse()) ctx.lineTo(x, y);
    ctx.closePath();
    ctx.fill();
  }

  private drawHitFlashes(ctx: Ctx, now: number): void {
    const { g } = this;
    for (const l of this.tl.landings) {
      const since = now - l.time;
      if (since < 0) break;
      if (since > 0.35 || l.notes.length === 0) continue;
      const p = since / 0.35;
      for (const n of l.notes) {
        const y = g.stringYs[n.string];
        ctx.strokeStyle = `rgba(${theme.glow},${0.7 * (1 - p)})`;
        ctx.lineWidth = 4 * g.s * (1 - p) + g.s;
        const x = this.x(l.time, now);
        this.notePath(ctx, x, x, y, g.noteR * (1.05 + 0.7 * p));
        ctx.stroke();
      }
    }
  }

  private drawBall(ctx: Ctx, now: number): void {
    const { g } = this;
    const y = ballY(this.tl, g, now);
    ctx.save();
    ctx.shadowColor = theme.accentGlow;
    ctx.shadowBlur = 30 * g.s;
    ctx.fillStyle = theme.ball;
    ctx.beginPath();
    ctx.arc(g.ballX, y, g.ballR, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  private drawCountIn(ctx: Ctx, now: number): void {
    const { g, tl } = this;
    const beats = tl.countInBeats;
    for (let i = 0; i < beats.length; i++) {
      const since = now - beats[i];
      if (since < 0 || since >= tl.beatLen) continue;
      const p = since / tl.beatLen;
      ctx.fillStyle = `rgba(255,255,255,${0.85 * (1 - p)})`;
      ctx.font = `bold ${Math.round((110 + 30 * p) * g.s)}px ${FONT}`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      const n = (i % this.song.beatsPerBar) + 1;
      ctx.fillText(String(n), g.width / 2, g.sectionY - 120 * g.s);
    }
  }

  private drawHud(ctx: Ctx, now: number, videoTime: number): void {
    const { g, song, opts } = this;
    const pad = 60 * g.s;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
    ctx.fillStyle = theme.text;
    ctx.font = `bold ${Math.round(42 * g.s)}px ${FONT}`;
    ctx.fillText(song.title, pad, 80 * g.s);
    if (song.artist) {
      ctx.fillStyle = theme.muted;
      ctx.font = `${Math.round(28 * g.s)}px ${FONT}`;
      ctx.fillText(song.artist, pad, 120 * g.s);
    }

    // Speed + tempo, top right.
    ctx.textAlign = 'right';
    const bpm = Math.round(song.bpm * opts.speed);
    ctx.font = `${Math.round(28 * g.s)}px ${FONT}`;
    ctx.fillStyle = theme.muted;
    ctx.fillText(`${bpm} BPM`, g.width - pad, 120 * g.s);
    // Non-standard tuning: highlighted so it's noticed before playing along.
    if (this.tuning) {
      ctx.fillStyle = theme.tuning;
      ctx.font = `bold ${Math.round(28 * g.s)}px ${FONT}`;
      ctx.fillText(this.tuning.name, g.width - pad, 162 * g.s);
      if (this.tuning.notes !== this.tuning.name) {
        ctx.fillStyle = theme.muted;
        ctx.font = `${Math.round(24 * g.s)}px ${FONT}`;
        ctx.fillText(this.tuning.notes, g.width - pad, 196 * g.s);
      }
    }
    const speedText = `${Math.round(opts.speed * 100)}%`;
    ctx.font = `bold ${Math.round(34 * g.s)}px ${FONT}`;
    const w = ctx.measureText(speedText).width + 34 * g.s;
    const bx = g.width - pad - w;
    const by = 46 * g.s;
    const bh = 46 * g.s;
    const slowed = opts.speed < 1;
    ctx.fillStyle = slowed ? theme.accent : 'rgba(255,255,255,0.12)';
    this.pill(ctx, bx + bh / 2, bx + w - bh / 2, by + bh / 2, bh / 2);
    ctx.fill();
    ctx.fillStyle = slowed ? theme.playedText : theme.text;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(speedText, bx + w / 2, by + bh / 2 + 2 * g.s);

    // Minimap progress.
    const m = this.minimap;
    const progress = Math.min(1, Math.max(0, (now - this.tl.start) / (this.tl.end - this.tl.start)));
    ctx.fillStyle = 'rgba(255,255,255,0.06)';
    ctx.fillRect(m.x, m.y - 4 * g.s, m.w, m.h + 8 * g.s);
    ctx.drawImage(m.future, m.x, m.y);
    const px = progress * m.w;
    if (px > 0) ctx.drawImage(m.past, 0, 0, px, m.h, m.x, m.y, px, m.h);
    ctx.fillStyle = theme.text;
    ctx.fillRect(m.x + px - g.s, m.y - 8 * g.s, 2.5 * g.s, m.h + 16 * g.s);

    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    ctx.font = `${Math.round(28 * g.s)}px ${FONT}`;
    ctx.fillStyle = theme.muted;
    ctx.fillText(`${fmt(videoTime)} / ${fmt(opts.videoDuration)}`, g.width - pad, m.y + m.h / 2);
  }
}

function fmt(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}
