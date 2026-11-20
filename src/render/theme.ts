import { GlobalFonts } from '@napi-rs/canvas';

const has = (f: string) => GlobalFonts.families.some((x) => x.family === f);

export const FONT = has('Bahnschrift') ? 'Bahnschrift' : has('Segoe UI') ? 'Segoe UI' : 'Arial';

/** Light amber accent (Tailwind amber-100) and the shades used with it. */
const amber = {
  100: '#fef3c7',
  200: '#fde68a',
  300: '#fcd34d',
  900: '#78350f',
};

export const theme = {
  // Warm graphite background (Tailwind stone scale).
  bgTop: '#292524',
  bgMid: '#1c1917',
  bgBottom: '#0c0a09',
  boardTop: '#262220',
  boardBottom: '#171412',
  boardEdge: '#3a3431',
  /** Soft warm light behind the ball column. */
  glow: '253,230,138', // amber-200 as "r,g,b"
  barLine: 'rgba(255,255,255,0.16)',
  beatLine: 'rgba(255,255,255,0.04)',
  /**
   * Note colour per fretting finger, in the familiar app layout (warm index, purple middle,
   * blue ring, red pinky) but with our own shades: a yellower gold, a softer lilac-purple,
   * a lighter blue and a pinker coral. Open strings are a soft warm grey. Numbers are white
   * (`fingerText`), with a soft shadow in the renderer to lift them off the light fills.
   */
  fingers: ['#a8a29e', '#ffb52e', '#c55bff', '#47b3ff', '#ff6670'],
  fingerText: ['#ffffff', '#ffffff', '#ffffff', '#ffffff', '#ffffff'],
  /** Fill of hollow notes (the "outline" note shape). */
  hollow: '#1c1917',
  /** String lines: the plain (thin) strings in amber-200, the three wound (thick) ones in amber-300. */
  stringThin: '#fde68a',
  stringThick: '#fcd34d',
  /** Played notes on the board: a dark tile with a dimmed cream outline and number. */
  playedFill: '#1f1b19',
  playedOutline: 'rgba(254,243,199,0.5)',
  playedNumber: 'rgba(254,243,199,0.6)',
  /** Played notes in the mini-map (solid cream); dark amber text on accent-filled badges. */
  played: amber[100],
  playedText: amber[900],
  accent: amber[100],
  accentGlow: amber[300],
  ball: amber[100],
  text: '#ffffff',
  muted: 'rgba(255,255,255,0.55)',
  /** Non-standard tuning label in the header. */
  tuning: amber[200],
  badge: '#1c1917',
  /** Faint pattern above the board, drawn in the glow colour. */
  pattern: 'waves' as 'waves' | 'halftone' | 'ripples',
  patternAlpha: 0.065,
};

export function fingerColor(finger: number | undefined): string {
  return theme.fingers[finger ?? 0] ?? theme.fingers[0];
}
