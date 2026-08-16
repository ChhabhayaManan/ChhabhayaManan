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
import { board as C, BOARD_GEO as GEO } from './lib/palette.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// Timing. Pace is fixed per step and the loop length follows from it — the
// other way round (fixed 20s loop, pace derived) means a busy year animates
// faster than a quiet one, which is backwards.
const STEP_MS = 200;                     // one cell of travel
const HOLD_S = 2;                        // pause on the finished snake before restarting
const MAX_WALK_S = 48;                   // past this the head covers 2 cells per frame
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
    // The real calendar's last week stops at today, so the mock does too —
    // otherwise the hole-filling path never gets exercised locally.
    const days = w === 52 ? 3 : 7;
    for (let d = 0; d < days; d++) {
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

  // The current week only runs up to today, so its lower rows come back empty
  // and the board renders with a ragged notch. Fill every hole with a real
  // empty cell: the grid is always a full cols x 7 rectangle, and the snake can
  // walk those squares like any other bare ground.
  for (let c = 0; c < cols; c++) {
    for (let r = 0; r < GEO.rows; r++) {
      const k = c * GEO.rows + r;
      if (!cells[k]) cells[k] = { c, r, count: 0, date: null, tier: 0, filler: true };
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

const DIRS = [[0, -1], [1, 0], [0, 1], [-1, 0]];

/**
 * Snake solver with a hard no-self-crossing rule.
 *
 * The body is a wall, always. Two pieces make that work on a 53x7 board, which
 * is a nasty shape for a snake — only seven rows means it boxes itself in fast:
 *
 *   1. Route with BFS over free cells to the *reachable* nearest food, not the
 *      manhattan-nearest one. Manhattan distance happily points at food on the
 *      far side of the body.
 *   2. Before committing to a move, flood fill from where the head would land.
 *      If the open space left is smaller than the body, that move is a coffin —
 *      take the roomiest alternative instead, even though it walks away from
 *      dinner. This is what stops the snake sealing itself into a pocket.
 *
 * Walking back over a cell it already ate is fine and expected — that is
 * flattened grass, not the body. Only body-on-body is forbidden.
 *
 * If every neighbour is body, the walk stops there. It ends up short rather
 * than cheating, and the legend reports the honest caught count.
 */
function solve(grid) {
  const { cols, rows, cells } = grid;
  const key = (c, r) => c * rows + r;
  const inside = (c, r) => c >= 0 && c < cols && r >= 0 && r < rows;

  const remaining = new Set();
  cells.forEach((cell, k) => { if (cell && cell.count > 0) remaining.add(k); });
  const foodTotal = remaining.size;

  const start = [0, Math.floor(rows / 2)];
  const path = [start];
  const eatenAt = [];
  const body = [start];              // oldest segment first
  const occ = new Set([key(...start)]);

  if (remaining.has(key(...start))) { remaining.delete(key(...start)); eatenAt.push(0); }

  /** First step of the shortest free-cell route to the nearest remaining food. */
  const routeStep = (head) => {
    const from = new Int32Array(cols * rows).fill(-1);
    const seen = new Uint8Array(cols * rows);
    const hk = key(...head);
    seen[hk] = 1;
    const queue = [head];
    let goal = -1;

    for (let i = 0; i < queue.length && goal < 0; i++) {
      const [c, r] = queue[i];
      for (const [dc, dr] of DIRS) {
        const nc = c + dc, nr = r + dr;
        if (!inside(nc, nr)) continue;
        const nk = key(nc, nr);
        if (seen[nk] || occ.has(nk)) continue;
        seen[nk] = 1;
        from[nk] = key(c, r);
        queue.push([nc, nr]);
        if (remaining.has(nk)) { goal = nk; break; }
      }
    }
    if (goal < 0) return null;

    let k = goal;
    while (from[k] !== hk) k = from[k];
    return [Math.floor(k / rows), k % rows];
  };

  /** Open cells reachable from `head` once `blocked` is treated as wall. */
  const openSpace = (head, blocked) => {
    const seen = new Uint8Array(cols * rows);
    const queue = [head];
    seen[key(...head)] = 1;
    let n = 1;
    for (let i = 0; i < queue.length; i++) {
      const [c, r] = queue[i];
      for (const [dc, dr] of DIRS) {
        const nc = c + dc, nr = r + dr;
        if (!inside(nc, nr)) continue;
        const nk = key(nc, nr);
        if (seen[nk] || blocked.has(nk)) continue;
        seen[nk] = 1; n++;
        queue.push([nc, nr]);
      }
    }
    return n;
  };

  /** The body as it would stand after stepping onto `next`. */
  const bodyAfter = (next) => {
    const after = new Set(occ);
    after.add(key(...next));
    const grows = remaining.has(key(...next));
    const len = Math.min(MAX_LENGTH, START_LENGTH + eatenAt.length + (grows ? 1 : 0));
    if (body.length + 1 > len) after.delete(key(...body[0]));
    return { after, len };
  };

  let stalled = false;
  let sinceMeal = 0;
  const guard = cols * rows * 12;
  // A legitimate trip to the far side of the board is under 60 steps. Much past
  // that and the remaining food is walled off, so stop instead of wandering the
  // frame budget away.
  const patience = (cols + rows) * 4;

  while (remaining.size && path.length < guard) {
    if (sinceMeal > patience) { stalled = true; break; }
    const head = path[path.length - 1];
    const free = [];
    for (const [dc, dr] of DIRS) {
      const nc = head[0] + dc, nr = head[1] + dr;
      if (inside(nc, nr) && !occ.has(key(nc, nr))) free.push([nc, nr]);
    }
    if (!free.length) { stalled = true; break; }

    // Preferred move first, then the rest by how much room they leave.
    const wanted = routeStep(head);
    const scored = free.map((n) => {
      const { after, len } = bodyAfter(n);
      return { n, room: openSpace(n, after), len, wanted: wanted && n[0] === wanted[0] && n[1] === wanted[1] };
    });
    scored.sort((a, b) => (b.wanted - a.wanted) || (b.room - a.room));

    const safe = scored.find((s) => s.room >= s.len);
    const pick = (safe ?? scored[0]).n;

    path.push(pick);
    const k = key(...pick);
    body.push(pick);
    occ.add(k);
    if (remaining.has(k)) { remaining.delete(k); eatenAt.push(path.length - 1); sinceMeal = 0; }
    else sinceMeal++;

    const len = Math.min(MAX_LENGTH, START_LENGTH + eatenAt.length);
    while (body.length > len) occ.delete(key(...body.shift()));
  }

  return { path, eatenAt, foodTotal, missed: remaining.size, stalled };
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
  const { releaseAt, finalLength } = tl;
  const { cell, gap, x0, y0, width, height } = GEO;

  const stride = Math.max(1, Math.ceil((path.length * STEP_MS) / (MAX_WALK_S * 1000)));
  const frames = Math.ceil(path.length / stride);
  const walkS = (frames * STEP_MS) / 1000;
  const loopS = walkS + HOLD_S;
  const active = (walkS / loopS) * 100; // percent of the loop spent moving
  const pct = (i) => ((Math.min(i, path.length) / stride / frames) * active).toFixed(3);
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

  // Four fills, nothing between them: grass, head, body, flattened. No trail
  // behind the head, no dim step as the tail leaves — a cell is one of the four
  // and flips to the next on a frame boundary.
  path.forEach(([c, r], i) => {
    const k = c * rows + r;
    const wasFood = cells[k] && cells[k].count > 0;
    push(k, i, C.head);
    push(k, i + 1, C.bodyStart);
    if (releaseAt[i] >= 0) push(k, releaseAt[i], wasFood ? C.eaten : C.eatenEmpty);
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
        parts.push(rect(x, y, cell, cell, base));
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
        parts.push(rect(x, y, cell, cell, base));
        continue;
      }

      const n = id++;
      keyframes.push(`@keyframes k${n}{${kf.join('')}}`);
      parts.push(rect(x, y, cell, cell, base, `class="a" style="animation-name:k${n}"`));

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

  // The head rides above everything, one keyframe per frame. Stepped like
  // everything else: it is on a square or it is on the next one, never between.
  // Interpolating it was tried and reads as too modern for the rest of the art.
  const headKf = [];
  for (let f = 0; f < frames; f++) {
    const [c, r] = path[Math.min(path.length - 1, f * stride)];
    const [x, y] = at(c, r);
    headKf.push(`${((f / frames) * active).toFixed(3)}%{transform:translate(${x}px,${y}px)}`);
  }
  const [ex, ey] = at(...path[path.length - 1]);
  headKf.push(`${active.toFixed(3)}%{transform:translate(${ex}px,${ey}px)}`);
  keyframes.push(`@keyframes head{${headKf.join('')}}`);

  const [hx, hy] = at(...path[0]);
  parts.push(
    `<g class="a" style="animation-name:head;transform:translate(${hx}px,${hy}px)">` +
      rect(0, 0, cell, cell, C.head) +
      rect(3, 4, 3, 3, C.eye) +
      rect(8, 4, 3, 3, C.eye) +
    `</g>`
  );

  // No legend row. The counts live in the SVG <title> for screen readers and in
  // the viewer's stat tiles; on the profile itself the board speaks for itself.

  const style =
    `.a{animation-duration:${loopS}s;animation-timing-function:steps(1,end);animation-iteration-count:infinite}` +
    keyframes.join('');

  const svg = doc({
    width, height,
    title: `${meta.login} contribution snake — ${eatenAt.length} of ${foodTotal} days caught, final length ${finalLength}`,
    desc: `Animated contribution grid for ${meta.login}. A snake walks the ${cols}-week board eating every day with activity; its body grows one segment per day eaten until it reaches its ceiling. ${meta.total} contributions in the last year.`,
    style,
    body: parts.join(''),
  });

  return { svg, stride, frames, walkS, loopS };
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
  const { svg, stride, frames, walkS, loopS } = render(grid, solved, tl, { login: o.login, total: cal.totalContributions });

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
    stride,
    frames,
    stepMs: STEP_MS,
    walkSeconds: walkS,
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
    `${walkS.toFixed(1)}s walk + ${HOLD_S}s hold = ${loopS.toFixed(1)}s loop, ` +
    `${(svg.length / 1024).toFixed(0)} KB`
  );
  if (solved.stalled) console.warn(`! walk stopped early with ${solved.missed} cells walled off`);
}

main().catch((e) => { console.error(e); process.exit(1); });
