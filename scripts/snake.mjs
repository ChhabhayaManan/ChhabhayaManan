#!/usr/bin/env node
// Growing-snake contribution board.
//
// Pipeline:  GraphQL contribution calendar -> tier the cells -> solve a walk
// over every non-empty cell -> emit one animated SVG + a data file the docs/
// viewer can scrub frame by frame.
//
// Length is 4 + (cells eaten so far), clamped at MAX_LENGTH. So the snake
// visibly grows for its first ~16 meals and then holds, shedding one tail cell
// per meal after that. Uncapped growth was tried first and buries the board:
// past a couple of hundred segments the body is a solid sheet of mint and the
// grid underneath stops reading at all.
//
// Usage:
//   node scripts/snake.mjs --login ChhabhayaManan --out dist/snake.svg
//   node scripts/snake.mjs --mock              # no network, deterministic grid

import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { doc, rect, seeded } from './lib/svg.mjs';
import { text, textWidth } from './lib/font.mjs';
import { board as C, BOARD_GEO as GEO } from './lib/palette.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// Timing. 20s of walking, then a 2s hold on the fully grown snake.
const WALK_S = 20;
const HOLD_S = 2;
const LOOP_S = WALK_S + HOLD_S;
const ACTIVE = (WALK_S / LOOP_S) * 100; // percent of the loop spent moving
const MAX_FRAMES = 420;                  // beyond this, the head moves >1 cell per frame
const HOT_FRAMES = 4;                    // how long a segment stays bright behind the head
const FADE_FRAMES = 2;                   // dim step as the tail leaves a cell
const START_LENGTH = 4;
const MAX_LENGTH = 20;                   // growth ceiling; past this, one in one out

// ------------------------------------------------------------------ args ----

function args(argv) {
  const o = { login: 'ChhabhayaManan', out: 'dist/snake.svg', data: 'dist/snake-data.json', mock: false };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--mock') o.mock = true;
    else if (a.startsWith('--')) o[a.slice(2)] = argv[++i];
  }
  return o;
}

// ------------------------------------------------------------------ data ----

const QUERY = `query($login: String!) {
  user(login: $login) {
    contributionsCollection {
      contributionCalendar {
        totalContributions
        weeks { contributionDays { date contributionCount weekday } }
      }
    }
  }
}`;

async function fetchCalendar(login, token) {
  const res = await fetch('https://api.github.com/graphql', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      'User-Agent': 'chhabhayamanan-snake',
    },
    body: JSON.stringify({ query: QUERY, variables: { login } }),
  });
  if (!res.ok) throw new Error(`GitHub GraphQL ${res.status}: ${await res.text()}`);
  const json = await res.json();
  if (json.errors) throw new Error(`GitHub GraphQL: ${JSON.stringify(json.errors)}`);
  const cal = json.data?.user?.contributionsCollection?.contributionCalendar;
  if (!cal) throw new Error(`no contribution calendar for "${login}"`);
  return cal;
}

/** Deterministic stand-in so the generator runs with no network. */
function mockCalendar() {
  const rnd = seeded(7);
  const weeks = [];
  let total = 0;
  const day = new Date(Date.UTC(2025, 7, 17));
  for (let w = 0; w < 53; w++) {
    const contributionDays = [];
    for (let d = 0; d < 7; d++) {
      const v = rnd();
      const count = v < 0.34 ? 0 : v < 0.62 ? 1 + Math.floor(rnd() * 2) : v < 0.86 ? 3 + Math.floor(rnd() * 5) : 9 + Math.floor(rnd() * 14);
      total += count;
      contributionDays.push({ date: day.toISOString().slice(0, 10), contributionCount: count, weekday: d });
      day.setUTCDate(day.getUTCDate() + 1);
    }
    weeks.push({ contributionDays });
  }
  return { totalContributions: total, weeks };
}

/**
 * Flatten the calendar into a cols x rows grid and bucket counts into 3
 * non-empty tiers using terciles of the non-zero distribution, which is what
 * GitHub's own heatmap does.
 */
function toGrid(cal) {
  const weeks = cal.weeks.slice(-GEO.cols);
  const cols = weeks.length;
  const cells = new Array(cols * GEO.rows).fill(null);

  for (let c = 0; c < cols; c++) {
    for (const d of weeks[c].contributionDays) {
      cells[c * GEO.rows + d.weekday] = { c, r: d.weekday, count: d.contributionCount, date: d.date, tier: 0 };
    }
  }

  const nonZero = cells.filter((x) => x && x.count > 0).map((x) => x.count).sort((a, b) => a - b);
  const q = (f) => (nonZero.length ? nonZero[Math.min(nonZero.length - 1, Math.floor(nonZero.length * f))] : 1);
  const t2 = q(1 / 3);
  const t3 = q(2 / 3);
  for (const cell of cells) {
    if (!cell) continue;
    cell.tier = cell.count === 0 ? 0 : cell.count <= t2 ? 1 : cell.count <= t3 ? 2 : 3;
  }

  return { cols, rows: GEO.rows, cells };
}

// ----------------------------------------------------------------- solve ----

/**
 * Greedy nearest-food walk, 4-directional, one cell per step.
 *
 * Self-overlap is allowed as a last resort rather than a hard wall: the body
 * only grows, so late in a dense year there is genuinely nowhere legal to go.
 * A plausible loop beats a failed build. Overlaps are counted and logged.
 */
function solve(grid) {
  const { cols, rows, cells } = grid;
  const key = (c, r) => c * rows + r;
  const isFood = (k) => cells[k] && cells[k].count > 0;

  const remaining = new Set();
  cells.forEach((cell, k) => { if (cell && cell.count > 0) remaining.add(k); });
  const foodTotal = remaining.size;

  const path = [[0, Math.floor(rows / 2)]];
  const eatenAt = [];           // path index of every meal
  let overlaps = 0;

  // Occupancy of the body, by cell key, as a count (a cell can be under two
  // segments when the path crosses itself).
  const occ = new Map();
  const bump = (k, n) => {
    const v = (occ.get(k) ?? 0) + n;
    if (v <= 0) occ.delete(k); else occ.set(k, v);
  };
  bump(key(...path[0]), 1);

  let cur = path[0];
  if (remaining.has(key(...cur))) { remaining.delete(key(...cur)); eatenAt.push(0); }

  const guard = cols * rows * 8;
  while (remaining.size && path.length < guard) {
    // Nearest remaining food by manhattan distance; ties break toward the top
    // left so the walk reads left-to-right overall.
    let target = null, best = Infinity;
    for (const k of remaining) {
      const c = Math.floor(k / rows), r = k % rows;
      const d = Math.abs(c - cur[0]) + Math.abs(r - cur[1]);
      if (d < best) { best = d; target = [c, r]; }
    }

    let steps = 0;
    while ((cur[0] !== target[0] || cur[1] !== target[1]) && steps++ < cols + rows + 4) {
      const dc = Math.sign(target[0] - cur[0]);
      const dr = Math.sign(target[1] - cur[1]);
      // Moves that close the gap, preferring the one that is not body.
      const options = [];
      if (dr) options.push([cur[0], cur[1] + dr]);
      if (dc) options.push([cur[0] + dc, cur[1]]);
      let next = options.find(([c, r]) => !occ.has(key(c, r)));
      if (!next) { next = options[0]; overlaps++; }

      cur = next;
      const k = key(cur[0], cur[1]);
      path.push([cur[0], cur[1]]);
      bump(k, 1);
      if (remaining.has(k)) { remaining.delete(k); eatenAt.push(path.length - 1); }

      // Retire the tail so `occ` reflects the body at this instant.
      const len = Math.min(MAX_LENGTH, START_LENGTH + eatenAt.length);
      const tailIdx = path.length - len;
      if (tailIdx >= 0) bump(key(...path[tailIdx]), -1);
    }
  }

  // Never leave the board broken: if the greedy walk stalled with food still on
  // the grid, sweep the rest serpentine so every cell is reachable.
  if (remaining.size) {
    for (let c = 0; c < cols; c++) {
      const order = c % 2 === 0 ? [0, 1, 2, 3, 4, 5, 6] : [6, 5, 4, 3, 2, 1, 0];
      for (const r of order) {
        if (path[path.length - 1][0] === c && path[path.length - 1][1] === r) continue;
        path.push([c, r]);
        const k = key(c, r);
        if (remaining.has(k)) { remaining.delete(k); eatenAt.push(path.length - 1); }
      }
    }
  }

  return { path, eatenAt, foodTotal, overlaps, isFood };
}

/**
 * Walk the solved path once and record, per path index, when that cell stops
 * being body. While the snake is still growing the tail stands still, which is
 * exactly the visual we want; once it hits the ceiling the tail advances one
 * cell per step.
 *
 * -1 means "never released" — the segments still on screen when the walk ends.
 * They have to stay put through the closing hold, otherwise the board empties
 * out right when it should be showing off the finished snake.
 */
function timeline(path, eatenAt) {
  const eatenSet = new Set(eatenAt);
  const releaseAt = new Array(path.length).fill(-1);
  let eaten = 0, tail = 0, longest = START_LENGTH;

  for (let t = 0; t < path.length; t++) {
    if (eatenSet.has(t)) eaten++;
    const len = Math.min(MAX_LENGTH, START_LENGTH + eaten);
    longest = Math.max(longest, len);
    const newTail = Math.max(tail, t - len + 1);
    for (let j = tail; j < newTail; j++) releaseAt[j] = t;
    tail = newTail;
  }

  return { releaseAt, finalLength: Math.min(MAX_LENGTH, START_LENGTH + eaten), longest };
}

// ------------------------------------------------------------------ draw ----

function render(grid, solved, tl, meta) {
  const { cols, rows, cells } = grid;
  const { path, eatenAt, foodTotal } = solved;
  const { releaseAt, finalLength, longest } = tl;
  const { cell, gap, x0, y0, width, height } = GEO;

  const stride = Math.max(1, Math.ceil(path.length / MAX_FRAMES));
  const frames = Math.ceil(path.length / stride);
  const pct = (i) => ((Math.min(i, path.length) / stride / frames) * ACTIVE).toFixed(3);
  const at = (c, r) => [x0 + c * (cell + gap), y0 + r * (cell + gap)];

  const parts = [];
  const keyframes = [];

  // Backdrop: sky strip, then turf below, so the board reads as a place rather
  // than a heatmap.
  parts.push(
    rect(0, 0, width, 6, C.skyTop),
    rect(0, 6, width, 8, C.skyMid),
    rect(0, 14, width, 8, C.skyLow),
    rect(0, 138, width, 10, C.turfEdge),
    rect(0, 148, width, height - 148, C.turf),
  );
  const rnd = seeded(7);
  for (let i = 0; i < 60; i++) parts.push(rect(Math.floor(rnd() * (width / 8)) * 8, 132, 8, 8, C.turfEdge));

  // Per-cell event lists. One visit to a cell produces one interval, so the
  // total number of keyframes is O(path length), not O(cells x frames).
  const events = new Map(); // cellKey -> [[frameIndex, fill], ...]
  const push = (k, i, fill) => {
    if (!events.has(k)) events.set(k, []);
    events.get(k).push([i, fill]);
  };

  path.forEach(([c, r], i) => {
    const k = c * rows + r;
    const wasFood = cells[k] && cells[k].count > 0;
    push(k, i, C.head);
    push(k, i + 1, '#a8ecb0');
    push(k, i + 1 + HOT_FRAMES * stride, C.bodyStart);
    if (releaseAt[i] >= 0) {
      push(k, releaseAt[i], C.bodyFade);
      push(k, releaseAt[i] + FADE_FRAMES * stride, wasFood ? C.eaten : C.eatenEmpty);
    }
  });

  let id = 0;
  const dots = [];

  for (let c = 0; c < cols; c++) {
    for (let r = 0; r < rows; r++) {
      const k = c * rows + r;
      const model = cells[k];
      if (!model) continue;
      const [x, y] = at(c, r);
      const base = C.tiers[model.tier];
      const list = (events.get(k) ?? []).slice().sort((a, b) => a[0] - b[0]);

      if (!list.length) {
        parts.push(rect(x, y, cell, cell, base, 'rx="2"'));
        continue;
      }

      // Collapse duplicate/overtaken frames: with steps(1,end) only the last
      // value written at a given percentage survives anyway.
      const kf = [`0%{fill:${base}}`];
      let last = base, lastPct = null;
      for (const [i, fill] of list) {
        if (i >= path.length && fill !== C.eaten && fill !== C.eatenEmpty) continue;
        const p = pct(i);
        if (fill === last) continue;
        if (p === lastPct) kf[kf.length - 1] = `${p}%{fill:${fill}}`;
        else kf.push(`${p}%{fill:${fill}}`);
        last = fill; lastPct = p;
      }
      if (kf.length === 1) {
        parts.push(rect(x, y, cell, cell, base, 'rx="2"'));
        continue;
      }

      const n = id++;
      keyframes.push(`@keyframes k${n}{${kf.join('')}}`);
      parts.push(rect(x, y, cell, cell, base, `rx="2" class="a" style="animation-name:k${n}"`));

      // Flattened-grass marker: a small dot that appears once the cell has been
      // walked over for good.
      if (model.count > 0) {
        const rel = list.find(([, f]) => f === C.eaten);
        if (rel) {
          const d = id++;
          keyframes.push(`@keyframes k${d}{0%{opacity:0}${pct(rel[0])}%{opacity:1}}`);
          dots.push(rect(x + 5, y + 5, 4, 4, C.eatenDot, `class="a" style="animation-name:k${d};opacity:0"`));
        }
      }
    }
  }
  parts.push(...dots);

  // The head rides above everything, one keyframe per frame.
  const headKf = [];
  for (let f = 0; f < frames; f++) {
    const [c, r] = path[Math.min(path.length - 1, f * stride)];
    const [x, y] = at(c, r);
    headKf.push(`${((f / frames) * ACTIVE).toFixed(3)}%{transform:translate(${x}px,${y}px)}`);
  }
  const [ex, ey] = at(...path[path.length - 1]);
  headKf.push(`${ACTIVE.toFixed(3)}%{transform:translate(${ex}px,${ey}px)}`);
  keyframes.push(`@keyframes head{${headKf.join('')}}`);

  const [hx, hy] = at(...path[0]);
  parts.push(
    `<g class="a" style="animation-name:head;transform:translate(${hx}px,${hy}px)">` +
      rect(0, 0, cell, cell, C.head, 'rx="4"') +
      rect(3, 4, 3, 3, C.eye) +
      rect(8, 4, 3, 3, C.eye) +
    `</g>`
  );

  // Legend, in the same pixel type as the banner.
  const caught = `CAUGHT ${eatenAt.length}/${foodTotal}`;
  const lenLabel = `LONGEST ${longest}`;
  parts.push(text(caught, { x: 32, y: 176, scale: 1.5, fill: C.legend }));
  parts.push(text(lenLabel, { x: width - 32 - textWidth(lenLabel) * 1.5, y: 176, scale: 1.5, fill: C.legendMuted }));

  const style =
    `.a{animation-duration:${LOOP_S}s;animation-timing-function:steps(1,end);animation-iteration-count:infinite}` +
    keyframes.join('');

  const svg = doc({
    width, height,
    title: `${meta.login} contribution snake — ${eatenAt.length} of ${foodTotal} days caught, final length ${finalLength}`,
    desc: `Animated contribution grid for ${meta.login}. A snake walks the ${cols}-week board eating every day with activity; its body grows one segment per day eaten and never shrinks. ${meta.total} contributions in the last year.`,
    style,
    body: parts.join(''),
  });

  return { svg, stride, frames };
}

// ------------------------------------------------------------------ main ----

async function main() {
  const o = args(process.argv);
  const token = process.env.GITHUB_TOKEN || process.env.SNAKE_TOKEN;

  let cal;
  if (o.mock || !token) {
    if (!o.mock) console.warn('! no GITHUB_TOKEN in env — falling back to the mock grid');
    cal = mockCalendar();
  } else {
    cal = await fetchCalendar(o.login, token);
  }

  const grid = toGrid(cal);
  const solved = solve(grid);
  const tl = timeline(solved.path, solved.eatenAt);
  const { svg, stride, frames } = render(grid, solved, tl, { login: o.login, total: cal.totalContributions });

  const outPath = resolve(ROOT, o.out);
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, svg);

  const dataPath = resolve(ROOT, o.data);
  writeFileSync(dataPath, JSON.stringify({
    login: o.login,
    generated: new Date().toISOString(),
    total: cal.totalContributions,
    cols: grid.cols,
    rows: grid.rows,
    startLength: START_LENGTH,
    maxLength: MAX_LENGTH,
    hotFrames: HOT_FRAMES,
    fadeFrames: FADE_FRAMES,
    stride,
    frames,
    walkSeconds: WALK_S,
    holdSeconds: HOLD_S,
    foodTotal: solved.foodTotal,
    finalLength: tl.finalLength,
    longest: tl.longest,
    cells: grid.cells.map((c) => (c ? [c.c, c.r, c.tier, c.count, c.date] : null)),
    path: solved.path,
    eatenAt: solved.eatenAt,
    releaseAt: tl.releaseAt,
  }));

  console.log(
    `snake: ${solved.path.length} steps -> ${frames} frames (stride ${stride}), ` +
    `${solved.eatenAt.length}/${solved.foodTotal} caught, longest ${tl.longest}, ` +
    `${solved.overlaps} forced overlaps, ${(svg.length / 1024).toFixed(0)} KB`
  );
}

main().catch((e) => { console.error(e); process.exit(1); });
