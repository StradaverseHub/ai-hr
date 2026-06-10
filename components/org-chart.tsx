'use client';

import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import Link from 'next/link';
import { ChevronDown, ChevronUp, Minus, Plus, Search } from 'lucide-react';
import { Avatar } from '@/components/ui';
import { cn } from '@/lib/utils';

export type OrgEmp = {
  employmentId: string;
  name: string;
  role: string | null;
  department: string | null;
};
export type OrgEdge = {
  manager: string;
  subordinate: string;
  type: 'administrative' | 'functional' | 'project' | 'dotted';
};

/** Connector style per reporting-relationship type — the whole point: direct vs dotted etc. */
const LINE: Record<OrgEdge['type'], { label: string; stroke: string; dash?: string }> = {
  administrative: { label: 'Direct', stroke: '#6366f1' },
  functional: { label: 'Functional', stroke: '#0d9488' },
  project: { label: 'Project', stroke: '#9333ea' },
  dotted: { label: 'Dotted-line', stroke: '#d97706', dash: '5 6' },
};

const DEPT_PALETTE = ['#6366f1', '#0d9488', '#d97706', '#db2777', '#0ea5e9', '#65a30d', '#e11d48'];
const deptColor = (d: string | null) =>
  d ? DEPT_PALETTE[[...d].reduce((a, c) => a + c.charCodeAt(0), 0) % DEPT_PALETTE.length] : '#94a3b8';

const Z_MIN = 0.5;
const Z_MAX = 1.5;
const NONE = new Set<string>();

type Pos = { cx: number; cy: number; t: number; b: number; l: number; r: number };

const matchText = (e: OrgEmp) => `${e.name} ${e.role ?? ''} ${e.department ?? ''}`.toLowerCase();

export function OrgChart({ employees, edges }: { employees: OrgEmp[]; edges: OrgEdge[] }) {
  const empById = new Map(employees.map((e) => [e.employmentId, e]));
  const childrenByMgr = new Map<string, string[]>();
  const hasAdminMgr = new Set<string>();
  for (const e of edges) {
    if (e.type !== 'administrative') continue;
    if (!empById.has(e.manager) || !empById.has(e.subordinate)) continue;
    if (!childrenByMgr.has(e.manager)) childrenByMgr.set(e.manager, []);
    childrenByMgr.get(e.manager)!.push(e.subordinate);
    hasAdminMgr.add(e.subordinate);
  }
  const roots = employees.filter((e) => !hasAdminMgr.has(e.employmentId));

  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [query, setQuery] = useState('');
  const [scale, setScale] = useState(1);

  const q = query.trim().toLowerCase();
  // Searching reveals everything — a match hidden inside a collapsed subtree is useless.
  const effCollapsed = q ? NONE : collapsed;
  const matches = q
    ? new Set(employees.filter((e) => matchText(e).includes(q)).map((e) => e.employmentId))
    : null;

  const toggle = (id: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const treeRef = useRef<HTMLDivElement>(null);
  const nodeRefs = useRef(new Map<string, HTMLElement>());
  const [box, setBox] = useState<{ w: number; h: number; pos: Map<string, Pos> }>({
    w: 0,
    h: 0,
    pos: new Map(),
  });

  useLayoutEffect(() => {
    const tree = treeRef.current;
    if (!tree) return;
    const measure = () => {
      const base = tree.getBoundingClientRect();
      const pos = new Map<string, Pos>();
      for (const [id, el] of nodeRefs.current) {
        const r = el.getBoundingClientRect();
        // Rects are in visual (scaled) pixels; the SVG lives inside the scaled
        // container and uses layout pixels, so divide the offsets back by scale.
        pos.set(id, {
          cx: (r.left - base.left + r.width / 2) / scale,
          cy: (r.top - base.top + r.height / 2) / scale,
          t: (r.top - base.top) / scale,
          b: (r.bottom - base.top) / scale,
          l: (r.left - base.left) / scale,
          r: (r.right - base.left) / scale,
        });
      }
      setBox({ w: tree.scrollWidth, h: tree.scrollHeight, pos });
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(tree);
    return () => ro.disconnect();
  }, [employees, edges, effCollapsed, scale]);

  // Bring the first search hit into view.
  useEffect(() => {
    if (!q) return;
    const first = employees.find((e) => matchText(e).includes(q));
    if (first)
      nodeRefs.current
        .get(first.employmentId)
        ?.scrollIntoView({ behavior: 'smooth', inline: 'center', block: 'nearest' });
  }, [q, employees]);

  const setNode = (id: string) => (el: HTMLElement | null) => {
    if (el) nodeRefs.current.set(id, el);
    else nodeRefs.current.delete(id);
  };

  // Connector paths from measured node positions (hidden nodes simply have no position).
  const paths = edges.flatMap((e, i) => {
    const m = box.pos.get(e.manager);
    const s = box.pos.get(e.subordinate);
    if (!m || !s) return [];
    const style = LINE[e.type];
    let d: string;
    if (e.type === 'administrative') {
      const px = m.cx;
      const py = m.b;
      const cx = s.cx;
      const cy = s.t;
      const midY = (py + cy) / 2;
      const r = Math.min(8, Math.abs(cx - px) / 2, Math.max((cy - py) / 2, 0));
      if (Math.abs(cx - px) < 1 || r < 1) {
        d = `M ${px} ${py} L ${cx} ${cy}`;
      } else {
        const dir = cx > px ? 1 : -1;
        d = `M ${px} ${py} L ${px} ${midY - r} Q ${px} ${midY} ${px + dir * r} ${midY} L ${cx - dir * r} ${midY} Q ${cx} ${midY} ${cx} ${midY + r} L ${cx} ${cy}`;
      }
    } else if (Math.abs(s.cy - m.cy) < 24) {
      // same level → connect nearest sides
      const fromR = s.cx >= m.cx;
      const x1 = fromR ? m.r : m.l;
      const x2 = fromR ? s.l : s.r;
      const mx = (x1 + x2) / 2;
      d = `M ${x1} ${m.cy} C ${mx} ${m.cy}, ${mx} ${s.cy}, ${x2} ${s.cy}`;
    } else {
      // different level → connect top/bottom with a smooth curve
      const down = s.cy > m.cy;
      const y1 = down ? m.b : m.t;
      const y2 = down ? s.t : s.b;
      const my = (y1 + y2) / 2;
      d = `M ${m.cx} ${y1} C ${m.cx} ${my}, ${s.cx} ${my}, ${s.cx} ${y2}`;
    }
    return [{ key: `${e.manager}-${e.subordinate}-${i}`, d, stroke: style.stroke, dash: style.dash }];
  });

  const renderNode = (id: string): ReactNode => {
    const e = empById.get(id);
    if (!e) return null;
    const hit = matches?.has(id) ?? false;
    return (
      <Link
        ref={setNode(id)}
        href={`/people/${id}`}
        className={cn(
          'relative z-10 flex w-52 flex-col gap-2 rounded-2xl border border-border bg-card p-3 shadow-[var(--shadow-card)] transition-colors hover:border-primary',
          hit && 'border-transparent ring-2 ring-primary',
          matches && !hit && 'opacity-50',
        )}
      >
        <div className="flex items-center gap-2.5">
          <Avatar name={e.name} className="size-9 text-xs" />
          <div className="min-w-0">
            <div className="truncate text-sm font-semibold text-foreground">{e.name}</div>
            <div className="truncate text-xs text-muted-foreground">{e.role ?? '—'}</div>
          </div>
        </div>
        <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <span className="size-2 shrink-0 rounded-full" style={{ background: deptColor(e.department) }} />
          <span className="truncate">{e.department ?? '—'}</span>
        </div>
      </Link>
    );
  };

  const zoomBtn =
    'grid size-7 place-items-center rounded-lg border border-border bg-card text-muted-foreground transition duration-150 ease-snappy hover:bg-accent hover:text-foreground active:scale-95 disabled:pointer-events-none disabled:opacity-40';

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-x-5 gap-y-3">
        <div className="flex flex-wrap items-center gap-x-5 gap-y-2 text-xs text-muted-foreground">
          {(Object.keys(LINE) as OrgEdge['type'][]).map((t) => (
            <span key={t} className="inline-flex items-center gap-2">
              <svg width="22" height="8" aria-hidden className="overflow-visible">
                <line
                  x1="0"
                  y1="4"
                  x2="22"
                  y2="4"
                  stroke={LINE[t].stroke}
                  strokeWidth="2"
                  strokeDasharray={LINE[t].dash}
                  strokeLinecap="round"
                />
              </svg>
              {LINE[t].label}
            </span>
          ))}
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <div className="relative">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
            <input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search people…"
              aria-label="Search the org chart"
              className="h-8 w-48 rounded-lg border border-border bg-card pl-8 pr-2 text-sm outline-none transition-colors placeholder:text-muted-foreground focus-visible:border-ring"
            />
          </div>
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={() => setScale((s) => Math.max(Z_MIN, +(s - 0.1).toFixed(1)))}
              disabled={scale <= Z_MIN}
              aria-label="Zoom out"
              className={zoomBtn}
            >
              <Minus className="size-4" />
            </button>
            <button
              type="button"
              onClick={() => setScale(1)}
              title="Reset zoom"
              className="h-7 min-w-12 rounded-lg border border-border bg-card px-1.5 text-xs font-medium tabular-nums text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            >
              {Math.round(scale * 100)}%
            </button>
            <button
              type="button"
              onClick={() => setScale((s) => Math.min(Z_MAX, +(s + 0.1).toFixed(1)))}
              disabled={scale >= Z_MAX}
              aria-label="Zoom in"
              className={zoomBtn}
            >
              <Plus className="size-4" />
            </button>
          </div>
        </div>
      </div>

      {matches && matches.size === 0 && (
        <p className="mb-3 text-xs text-muted-foreground">No one matches &ldquo;{query.trim()}&rdquo;.</p>
      )}

      <div className="overflow-x-auto pb-2">
        <div
          className="relative mx-auto"
          style={box.w ? { width: box.w * scale, height: box.h * scale } : undefined}
        >
          <div
            ref={treeRef}
            className="relative w-max px-6 py-2"
            style={{ transform: `scale(${scale})`, transformOrigin: 'top left' }}
          >
            <svg
              className="pointer-events-none absolute left-0 top-0 z-0"
              width={box.w || 1}
              height={box.h || 1}
              fill="none"
            >
              {paths.map((p) => (
                <path
                  key={p.key}
                  d={p.d}
                  stroke={p.stroke}
                  strokeWidth="2"
                  strokeDasharray={p.dash}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              ))}
            </svg>
            <div className="relative z-10 flex items-start gap-12">
              {roots.map((r) => (
                <Subtree
                  key={r.employmentId}
                  id={r.employmentId}
                  childrenByMgr={childrenByMgr}
                  collapsed={effCollapsed}
                  onToggle={toggle}
                  renderNode={renderNode}
                />
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function Subtree({
  id,
  childrenByMgr,
  collapsed,
  onToggle,
  renderNode,
}: {
  id: string;
  childrenByMgr: Map<string, string[]>;
  collapsed: Set<string>;
  onToggle: (id: string) => void;
  renderNode: (id: string) => ReactNode;
}) {
  const kids = childrenByMgr.get(id) ?? [];
  const isCollapsed = collapsed.has(id);
  return (
    <div className="flex flex-col items-center">
      {renderNode(id)}
      {kids.length > 0 && (
        <button
          type="button"
          onClick={() => onToggle(id)}
          aria-expanded={!isCollapsed}
          aria-label={isCollapsed ? `Expand ${kids.length} reports` : 'Collapse reports'}
          className="relative z-20 mt-2 inline-flex h-6 items-center gap-1 rounded-full border border-border bg-card px-2 text-[11px] font-medium text-muted-foreground shadow-[var(--shadow-sm)] transition duration-150 ease-snappy hover:bg-accent hover:text-foreground active:scale-95"
        >
          {isCollapsed ? (
            <>
              +{kids.length}
              <ChevronDown className="size-3" />
            </>
          ) : (
            <ChevronUp className="size-3" />
          )}
        </button>
      )}
      {kids.length > 0 && !isCollapsed && (
        <div className="flex items-start gap-10 pt-10">
          {kids.map((k) => (
            <Subtree
              key={k}
              id={k}
              childrenByMgr={childrenByMgr}
              collapsed={collapsed}
              onToggle={onToggle}
              renderNode={renderNode}
            />
          ))}
        </div>
      )}
    </div>
  );
}
