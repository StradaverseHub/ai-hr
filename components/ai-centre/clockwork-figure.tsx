'use client';
import * as React from 'react';

/** How it works, drawn as an exploded watch movement (docs/design/ai-centre/mockup.html, owner-approved
 * 1 November 2026, after the "neon diagrams" reference). A closed watch opens once into its layers:
 * dial = interfaces, escapement = agentic harness with the balance wheel = the model, calendar ring =
 * context, gear train = capabilities, mainspring = system of record, case = trust and governance, crown =
 * guard, engraved caseback = outcome record. Pure SVG line art from the geometry below: no asset, no
 * library. Decorative: the step text beside it carries the meaning, and the figure has one text label. */

export type ClockworkLayer = 'interfaces' | 'harness' | 'context' | 'capabilities' | 'record';
export type ClockworkTarget = ClockworkLayer | 'guard' | 'outcome';
type Pt = readonly [number, number];
type Shape = Readonly<{ kind: 'poly' | 'line'; points: string; cls: 'face' | 'side' | 'detail' | 'wire' }>;

const S = 0.72, CX = 450;
const Z_OPEN = { found: 0, record: 74, capabilities: 148, context: 222, harness: 296, interfaces: 378 } as const;
const Z_CLOSED = { found: 0, record: 2, capabilities: 4, context: 6, harness: 8, interfaces: 16 } as const;
const C: Pt = [150, 150];
const RADIUS = { found: 158, record: 124, capabilities: 120, context: 130, harness: 118, interfaces: 134 } as const;

function projector(cy: number) {
  return (x: number, y: number, z: number): Pt => [CX + (x - y) * 0.866 * S, cy + ((x + y) * 0.5 - z) * S];
}
const at = (r: number, angle: number): Pt => [C[0] + r * Math.cos(angle), C[1] + r * Math.sin(angle)];
const disc = (cx: number, cy: number, r: number, n = 56): Pt[] => Array.from({ length: n }, (_, i) => { const t = i / n * 2 * Math.PI; return [cx + r * Math.cos(t), cy + r * Math.sin(t)] as const; });
function gear(cx: number, cy: number, r: number, teeth: number, depth: number): Pt[] {
  const pts: Pt[] = [];
  for (let i = 0; i < teeth; i++) {
    const a = i / teeth * 2 * Math.PI, w = Math.PI / teeth;
    for (const [da, rr] of [[-w * 0.55, r - depth], [-w * 0.3, r], [w * 0.3, r], [w * 0.55, r - depth]] as const) pts.push([cx + rr * Math.cos(a + da), cy + rr * Math.sin(a + da)]);
  }
  return pts;
}
const spiral = (cx: number, cy: number, r0: number, r1: number, turns: number): Pt[] =>
  Array.from({ length: Math.round(turns * 36) + 1 }, (_, i) => { const t = i / 36 * 2 * Math.PI, r = r0 + (r1 - r0) * i / (turns * 36); return [cx + r * Math.cos(t), cy + r * Math.sin(t)] as const; });

/** Builds the SVG shapes for one projection. Each call returns new arrays; nothing is cached across steps. */
function drawer(cy: number) {
  const P = projector(cy);
  const pts = (list: readonly Pt[]) => list.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(' ');
  const outline = (poly: readonly Pt[], z: number, cls: Shape['cls'] = 'detail'): Shape => ({ kind: 'poly', points: pts(poly.map(([x, y]) => P(x, y, z))), cls });
  const line = (list: readonly Pt[], z: number, cls: Shape['cls'] = 'detail'): Shape => ({ kind: 'line', points: pts(list.map(([x, y]) => P(x, y, z))), cls });
  /** A solid with its visible sides (edges whose outward normal faces the viewer), then its top face. */
  function solid(poly: readonly Pt[], z: number, t: number): Shape[] {
    const out: Shape[] = [];
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i], b = poly[(i + 1) % poly.length], nx = b[1] - a[1], ny = -(b[0] - a[0]);
      if (nx + ny > 0) out.push({ kind: 'poly', cls: 'side', points: pts([P(a[0], a[1], z), P(b[0], b[1], z), P(b[0], b[1], z - t), P(a[0], a[1], z - t)]) });
    }
    out.push({ kind: 'poly', cls: 'face', points: pts(poly.map(([x, y]) => P(x, y, z))) });
    return out;
  }
  const box = (x: number, y: number, w: number, h: number, z: number, t: number) => solid([[x, y], [x + w, y], [x + w, y + h], [x, y + h]], z, t);
  return { P, outline, line, solid, box };
}

function layerShapes(d: ReturnType<typeof drawer>, key: keyof typeof Z_OPEN, z: number): Shape[] {
  const [cx, cy] = C, { outline, line, solid, box } = d;
  switch (key) {
    case 'found': return [...solid(disc(cx, cy, 158), z, 28), outline(disc(cx, cy, 142), z),
      ...[-0.62, 0.62, Math.PI - 0.62, Math.PI + 0.62].flatMap(a => { const [x, y] = at(166, a - Math.PI / 4); return box(x - 14, y - 14, 28, 28, z - 6, 10); })];
    case 'record': return [...solid(disc(cx, cy, 124), z, 6), ...solid(disc(102, 190, 46), z + 16, 16), line(spiral(102, 190, 8, 40, 3.2), z + 16),
      outline(disc(102, 190, 10), z + 16), ...[0, 1, 2].map(i => { const [x, y] = at(96, i * 2.1 + 0.4); return outline(disc(x, y, 5, 16), z); })];
    case 'capabilities': return [...solid(disc(cx, cy, 120), z, 4), ...solid(gear(196, 118, 54, 28, 6), z + 10, 8), outline(disc(196, 118, 10), z + 10),
      ...solid(gear(112, 196, 36, 20, 5), z + 10, 8), outline(disc(112, 196, 8), z + 10), ...solid(gear(204, 206, 22, 12, 4), z + 10, 8), outline(disc(204, 206, 5), z + 10)];
    case 'context': return [...solid(disc(cx, cy, 130), z, 5), outline(disc(cx, cy, 100), z),
      ...Array.from({ length: 31 }, (_, i) => { const a = i / 31 * 2 * Math.PI; return line([at(106, a), at(i % 5 === 0 ? 122 : 114, a)], z); })];
    case 'harness': return [...solid(disc(cx, cy, 118), z, 6), outline(disc(cx, cy, 64), z), ...solid(gear(232, 96, 22, 15, 4), z + 8, 6),
      line([[214, 110], [196, 132], [176, 128]], z + 8), line([[196, 132], [206, 146]], z + 8)];
    case 'interfaces': return [...solid(disc(cx, cy, 134), z, 5), outline(disc(cx, cy, 124), z),
      ...Array.from({ length: 12 }, (_, i) => { const a = i / 12 * 2 * Math.PI; return line([at(i % 3 === 0 ? 96 : 104, a), at(116, a)], z); }),
      line([[cx, cy], at(62, -2.2)], z), line([[cx, cy], at(96, -0.6)], z), outline(disc(cx, cy, 6, 16), z), outline(disc(cx, cy, 142), z + 10, 'wire')];
  }
}

const SHAPE_CLASS: Readonly<Record<Shape['cls'], string>> = {
  face: 'fill-[#141518] stroke-[#3d4148] group-data-[on]:fill-[#2a1a10] group-data-[on]:stroke-[#fb8a4a]',
  side: 'fill-[#0f1012] stroke-[#3d4148] group-data-[on]:fill-[#1d130c] group-data-[on]:stroke-[#fb8a4a]',
  detail: 'fill-none stroke-[#4a4f57] group-data-[on]:stroke-[#fb8a4a]',
  wire: 'fill-none stroke-[#2c2f35] [stroke-dasharray:3_4]',
};
const MODEL_CLASS: Readonly<Record<Shape['cls'], string>> = {
  face: 'fill-[#221c3f] stroke-[#b9a6ff] [stroke-dasharray:4_3] group-data-[on]:[stroke-dasharray:none]',
  side: 'fill-[#110f1f] stroke-[#b9a6ff] [stroke-dasharray:4_3] group-data-[on]:[stroke-dasharray:none]',
  detail: 'fill-none stroke-[#b9a6ff]', wire: 'fill-none stroke-[#b9a6ff]',
};
function Shapes({ shapes, glass, model }: { shapes: readonly Shape[]; glass?: boolean; model?: boolean }) {
  const classes = model ? MODEL_CLASS : SHAPE_CLASS;
  return <>{shapes.map((shape, i) => {
    const className = `${classes[shape.cls]} [stroke-linejoin:round] [stroke-linecap:round]${glass && shape.cls === 'face' ? ' [fill-opacity:.42]' : ''}${glass && shape.cls === 'side' ? ' [fill-opacity:.6]' : ''}`;
    return shape.kind === 'poly' ? <polygon key={i} points={shape.points} className={className} strokeWidth={1} /> : <polyline key={i} points={shape.points} className={className} strokeWidth={1} />;
  })}</>;
}

/** Label geometry in viewBox units (about 1px at the figure's 1000-unit width). A row is a name and a part line,
 * each allowed two lines; rows on the right are at least LABEL_GAP apart so a wrapped row does not reach the next. */
const LABEL_WIDTH = 276, LABEL_RISE = 16, LABEL_HEIGHT = 64, LABEL_GAP = 50;
/** Rows stay below the title and caption printed over the top left (and the mark at the top right) and inside the
 * frame: the opened model rose above the title and was cut by the figure's top edge (staging, 3 November 2026). */
export const LABEL_TOP = 96, LABEL_BOTTOM = 620 - LABEL_HEIGHT + LABEL_RISE;
/** Text colours on the #0c0d0f panel, each at least 4.5:1 (on 8.2/8.8, rest 15.9/7.4, dimmed 8.1/5.2). */
const LABEL_TONE = {
  on: { name: 'text-[#fb8a4a]', part: 'text-[#d9a37f]' },
  rest: { name: 'text-[#e8e8ea]', part: 'text-[#9aa0a8]' },
  dim: { name: 'text-[#a3a8b0]', part: 'text-[#80858d]' },
} as const;

export type ClockworkLabels = Readonly<Record<ClockworkLayer | 'model' | 'foundation' | 'guard' | 'outcome', Readonly<{ name: string; part: string }>>>;

/** `active` is the part the current step explains (null for the overview). `reduced` shows the watch open
 * and still: no opening and no travel. */
/** `faceLabel` is printed on the dial, the way a maker's name sits on a watch face (the architecture label). */
export function ClockworkFigure({ active, labels, title, caption, mark, reduced, label, faceLabel }: {
  active: ClockworkTarget | null; labels: ClockworkLabels; title: string; caption: string; mark: string; reduced: boolean; label: string; faceLabel?: string;
}) {
  const [open, setOpen] = React.useState(reduced ? 1 : 0);
  const figure = React.useRef<HTMLDivElement>(null);
  // Opens once, the first time the figure is on screen.
  React.useEffect(() => {
    if (reduced) { setOpen(1); return; }
    if (open >= 1) return;
    let frame = 0, started = 0;
    const run = () => {
      const tick = (now: number) => {
        if (!started) started = now + 350;
        const p = Math.min(1, Math.max(0, (now - started) / 1500));
        setOpen(1 - Math.pow(1 - p, 3));
        if (p < 1) frame = requestAnimationFrame(tick);
      };
      frame = requestAnimationFrame(tick);
    };
    const node = figure.current;
    if (!node || typeof IntersectionObserver === 'undefined') { run(); return () => cancelAnimationFrame(frame); }
    const observer = new IntersectionObserver(entries => { if (entries.some(entry => entry.isIntersecting)) { observer.disconnect(); run(); } }, { threshold: 0.3 });
    observer.observe(node);
    return () => { observer.disconnect(); cancelAnimationFrame(frame); };
  }, [reduced]); // eslint-disable-line react-hooks/exhaustive-deps

  const e = open, cy = 368 - (1 - e) * 130, d = drawer(cy);
  const Z = Object.fromEntries((Object.keys(Z_OPEN) as (keyof typeof Z_OPEN)[]).map(key => [key, Z_CLOSED[key] + (Z_OPEN[key] - Z_CLOSED[key]) * e])) as Record<keyof typeof Z_OPEN, number>;
  const modelZ = Z.harness + 12 + e * 16;
  const lit = (key: ClockworkTarget) => active === key;
  const order: (keyof typeof Z_OPEN)[] = ['found', 'record', 'capabilities', 'context', 'harness', 'interfaces'];
  const wires = e > 0.05 ? [Math.PI * 0.75, Math.PI * 0.25, -Math.PI * 0.25].map(angle => { const p = at(158, angle); return [d.P(p[0], p[1], Z.found), d.P(p[0], p[1], Z.interfaces)] as const; }) : [];

  type Row = { key: string; side: 'r' | 'l'; a: Pt; name: string; part: string; on: boolean; y?: number };
  const rows: Row[] = [...order].reverse().map(key => {
    const name = key === 'found' ? labels.foundation : labels[key];
    return { key, side: 'r' as const, a: d.P(...at(RADIUS[key], -Math.PI / 4), Z[key]), name: name.name, part: name.part, on: key !== 'found' && lit(key) };
  });
  rows.push({ key: 'model', side: 'l', a: d.P(...at(46, Math.PI * 0.75), modelZ), ...labels.model, on: lit('harness') });
  rows.push({ key: 'guard', side: 'l', a: d.P(134, 326, Z.found - 6), ...labels.guard, on: lit('guard') });
  rows.push({ key: 'outcome', side: 'r', a: d.P(...at(40, -Math.PI / 4), Z.found), ...labels.outcome, on: lit('outcome') });
  let last = LABEL_TOP - LABEL_GAP;
  for (const row of rows.filter(r => r.side === 'r').sort((p, q) => p.a[1] - q.a[1])) { row.y = Math.min(LABEL_BOTTOM, Math.max(row.a[1], last + LABEL_GAP)); last = row.y; }
  for (const row of rows.filter(r => r.side === 'l')) row.y = Math.min(LABEL_BOTTOM, Math.max(row.a[1], LABEL_TOP));
  const token: Pt | null = !active || e < 0.95 ? null
    : active === 'guard' ? d.P(150, 326, Z.found - 6) : active === 'outcome' ? d.P(150, 150, Z.found)
    : d.P(...at(158, Math.PI * 0.75), Z[active]);

  return (
    // Sized to the screen so the figure and the step controls beside it are visible together (1280x800 upwards).
    <div ref={figure} data-clockwork-figure className="relative h-[clamp(420px,calc(100dvh-19rem),620px)] overflow-hidden rounded-2xl border border-[#1d1f23] bg-[#0c0d0f]">
      <div className="absolute left-6 top-5"><p className="text-[19px] font-semibold tracking-tight text-[#f2f2f3]">{title}</p><p className="mt-1.5 text-[11px] uppercase tracking-[0.12em] text-[#878c94]">{caption}</p></div>
      <p className="absolute right-6 top-6 text-[11px] uppercase tracking-[0.12em] text-[#878c94]">{mark}</p>
      <svg viewBox="0 0 1000 620" preserveAspectRatio="xMidYMid meet" role="img" aria-label={label} className="absolute inset-0 size-full">
        {wires.map(([p, q], i) => <line key={i} x1={p[0]} y1={p[1]} x2={q[0]} y2={q[1]} className="stroke-[#2c2f35] [stroke-dasharray:3_4]" strokeWidth={1} />)}
        {order.map(key => (
          <React.Fragment key={key}>
            <g className="group" data-on={key !== 'found' && lit(key as ClockworkTarget) ? '' : undefined} data-part={key}>
              <Shapes shapes={layerShapes(d, key, Z[key])} glass={key === 'interfaces' && e > 0.8} />
            </g>
            {key === 'found' && <>
              <g className="group" data-on={lit('guard') ? '' : undefined} data-part="guard"><Shapes shapes={[...d.solid(disc(150, 326, 16, 24), Z.found - 6, 22), ...d.box(140, 308, 20, 10, Z.found - 10, 12)]} /></g>
              <g className="group" data-on={lit('outcome') ? '' : undefined} data-part="outcome"><Shapes shapes={[d.outline(disc(150, 150, 40), Z.found), ...[134, 146, 158, 170].map((y, i) => d.line([[124 + i * 2, y], [176 - i * 2, y]], Z.found))]} /></g>
            </>}
            {key === 'interfaces' && faceLabel && (() => {
              // Lies flat on the dial: the plane's x and y axes as the text's own axes.
              const [tx, ty] = d.P(150, 196, Z.interfaces);
              return <text transform={`matrix(${0.866 * S} ${0.5 * S} ${-0.866 * S} ${0.5 * S} ${tx} ${ty})`} textAnchor="middle" data-face-label
                className="fill-[#9aa0a8] text-[15px] font-semibold tracking-[0.18em] [font-variant:small-caps]">{faceLabel}</text>;
            })()}
            {key === 'harness' && <g className="group" data-on={lit('harness') ? '' : undefined} data-part="model">
              <Shapes model shapes={[...d.solid(disc(150, 150, 46), modelZ, 6), d.outline(disc(150, 150, 34), modelZ), ...[0, 1, 2].map(i => d.line([at(8, i * 2.09), at(34, i * 2.09)], modelZ)), d.line(spiral(150, 150, 6, 26, 2.6), modelZ + 2)]} />
            </g>}
          </React.Fragment>
        ))}
        {e > 0.6 && rows.map(row => {
          const right = row.side === 'r', lx = right ? 700 : 300, y = row.y!;
          const tone = row.on ? 'on' : active ? 'dim' : 'rest';
          // foreignObject, not <text>: SVG text neither wraps nor ellipsises, so a long locale (Tamil) ran past
          // the panel edge (review M13; the Control Tower loop diagram learnt the same in r286). HTML inside
          // wraps to two lines within LABEL_WIDTH. Dimmed by colour, never by opacity, so every label keeps
          // at least 4.5:1 on the panel (review L1). The sans face carries Vietnamese, Thai and Tamil, which
          // the Latin-only mono face does not (review L10).
          return <g key={row.key} data-label={row.key}>
            <polyline points={`${row.a[0].toFixed(1)},${row.a[1].toFixed(1)} ${right ? lx - 24 : lx + 24},${y.toFixed(1)} ${lx},${y.toFixed(1)}`} fill="none" strokeWidth={1} className={tone === 'on' ? 'stroke-[#fb8a4a]' : 'stroke-[#3a3e45]'} />
            <foreignObject x={right ? lx + 8 : lx - 8 - LABEL_WIDTH} y={y - LABEL_RISE} width={LABEL_WIDTH} height={LABEL_HEIGHT}>
              <div className={`flex flex-col leading-tight ${right ? 'items-start text-left' : 'items-end text-right'}`}>
                <p className={`line-clamp-2 break-words text-[13px] font-semibold ${LABEL_TONE[tone].name}`}>{row.name}</p>
                <p className={`line-clamp-2 break-words text-[10.5px] ${LABEL_TONE[tone].part}`}>{row.part}</p>
              </div>
            </foreignObject>
          </g>;
        })}
        <circle data-clockwork-token r={5.5} cx={0} cy={0} fill="#fb8a4a" stroke="#0c0d0f" strokeWidth={2.5}
          className={reduced ? 'transition-opacity duration-200' : 'transition-[transform,opacity] duration-[600ms] ease-[cubic-bezier(.16,1,.3,1)]'}
          style={{ opacity: token ? 1 : 0, transform: token ? `translate(${token[0]}px, ${token[1]}px)` : undefined }} />
      </svg>
    </div>
  );
}
