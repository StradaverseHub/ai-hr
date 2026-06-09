'use client';

import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import Link from 'next/link';
import { Avatar } from '@/components/ui';

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

type Pos = { cx: number; cy: number; t: number; b: number; l: number; r: number };

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
        pos.set(id, {
          cx: r.left - base.left + r.width / 2,
          cy: r.top - base.top + r.height / 2,
          t: r.top - base.top,
          b: r.bottom - base.top,
          l: r.left - base.left,
          r: r.right - base.left,
        });
      }
      setBox({ w: tree.scrollWidth, h: tree.scrollHeight, pos });
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(tree);
    return () => ro.disconnect();
  }, [employees, edges]);

  const setNode = (id: string) => (el: HTMLElement | null) => {
    if (el) nodeRefs.current.set(id, el);
    else nodeRefs.current.delete(id);
  };

  // Connector paths from measured node positions.
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
    const reports = childrenByMgr.get(id) ?? [];
    return (
      <Link
        ref={setNode(id)}
        href={`/people/${id}`}
        className="relative z-10 flex w-52 flex-col gap-2 rounded-2xl border border-border bg-card p-3 shadow-[var(--shadow-card)] transition-colors hover:border-primary"
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
          {reports.length > 0 && <span className="ml-auto tabular-nums text-foreground/70">+{reports.length}</span>}
        </div>
      </Link>
    );
  };

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center gap-x-5 gap-y-2 text-xs text-muted-foreground">
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

      <div className="overflow-x-auto pb-2">
        <div ref={treeRef} className="relative mx-auto w-max px-6 py-2">
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
                renderNode={renderNode}
              />
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

function Subtree({
  id,
  childrenByMgr,
  renderNode,
}: {
  id: string;
  childrenByMgr: Map<string, string[]>;
  renderNode: (id: string) => ReactNode;
}) {
  const kids = childrenByMgr.get(id) ?? [];
  return (
    <div className="flex flex-col items-center">
      {renderNode(id)}
      {kids.length > 0 && (
        <div className="flex items-start gap-10 pt-12">
          {kids.map((k) => (
            <Subtree key={k} id={k} childrenByMgr={childrenByMgr} renderNode={renderNode} />
          ))}
        </div>
      )}
    </div>
  );
}
