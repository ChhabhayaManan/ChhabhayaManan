// Minimal SVG emitters. Everything here returns a string; nothing is stateful.

export function rect(x, y, w, h, fill, extra = '') {
  return `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="${fill}"${extra ? ' ' + extra : ''}/>`;
}

/** Pixel-grid rect: coordinates are in art units of `unit` px. */
export function px(unit) {
  return (x, y, w, h, fill) => rect(x * unit, y * unit, w * unit, h * unit, fill);
}

export function doc({ width, height, title, desc = '', body, style = '' }) {
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"`,
    ` viewBox="0 0 ${width} ${height}" role="img" aria-label="${esc(title)}"`,
    ` shape-rendering="crispEdges">`,
    `<title>${esc(title)}</title>`,
    desc ? `<desc>${esc(desc)}</desc>` : '',
    style ? `<style>${style}</style>` : '',
    body,
    `</svg>`,
  ].join('');
}

export function esc(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

/** Deterministic PRNG so regenerated art is byte-identical run to run. */
export function seeded(seed) {
  let s = seed;
  return () => (s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
}
