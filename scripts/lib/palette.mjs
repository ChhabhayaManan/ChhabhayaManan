// Single source of truth for every colour in the profile.
// GBC discipline: max 4 tones per element, no gradients that aren't banded.

export const PIXEL = 8; // art grid unit, in px

export const sky = {
  deep: '#2f93d4',
  far: '#4aa8e0',
  near: '#7fc7ef',
  cloud: '#f2f7fa',
  cloudShade: '#e2eef5',
};

export const land = {
  light: '#5cb04f',
  mid: '#358a3d',
  dark: '#17361f',
  flower: '#f0c04a',
  stem: '#2b6b30',
};

export const dusk = {
  night: '#5c3a6b',
  violet: '#8c4a72',
  rose: '#c25a76',
  amber: '#f0a56a',
  gold: '#ffc98a',
  sunCore: '#fff0c0',
  sunMid: '#ffe49a',
  sunEdge: '#ffd07a',
  hill: '#5a3a5e',
  hillDark: '#3f2947',
  ground: '#241a33',
  canopy: '#2b1c33',
  text: '#ffd9a8',
};

// The creature + trainer stand-in. Original art, deliberately generic.
export const creature = {
  shellDark: '#4c5f78',
  shell: '#5a7089',
  belly: '#e8d9a8',
  eye: '#0f1a24',
  mouth: '#c96a7a',
  base: '#3d4f63',
};

// GitHub chrome the README sits on.
export const ui = {
  canvas: '#0d1117',
  panel: '#0f1a24',
  border: '#21262d',
  text: '#e6edf3',
  muted: '#8b949e',
};

// The contribution board.
export const board = {
  skyTop: '#123049',
  skyMid: '#16405e',
  skyLow: '#1b5273',
  turfEdge: '#14301d',
  turf: '#0f2417',
  tiers: ['#161b22', '#1f4a2c', '#2f7a41', '#4ac26b'],
  eaten: '#12281a',
  eatenEmpty: '#131820',
  eatenDot: '#1c3a24',
  bodyStart: '#7fe08a',
  bodyEnd: '#eaffd8',
  bodyFade: '#3f8f55', // one dim step as the tail slides off a cell
  head: '#eaffd8',
  eye: '#0d2b14',
  legend: '#7fe08a',
  legendMuted: '#7f9f88',
};

export const BOARD_GEO = {
  cols: 53,
  rows: 7,
  cell: 14,
  gap: 2,
  x0: 16,
  y0: 26,
  width: 880,
  height: 200,
};
