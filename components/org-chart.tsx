'use client';

import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import Link from 'next/link';
import {createPortal} from 'react-dom';
import { useTranslations } from 'next-intl';
import { ChevronDown, ChevronUp, Minus, Plus, Search } from 'lucide-react';
import { Avatar, EmployeeName } from '@/components/ui';
import { cn } from '@/lib/utils';
import {orgChartConnectorPath,orgChartSearchIds,type OrgChartEmployee,type OrgChartFilter} from '@/lib/org-chart-model';

export type OrgEmp = {
  employmentId: string;
  name: string;
  employeeCode: string | null;
  role: string | null;
  department: string | null;
} & Partial<Omit<OrgChartEmployee,'employmentId'|'name'|'employeeCode'|'role'|'department'>>;
export type OrgEdge = {
  manager: string;
  subordinate: string;
  type: 'administrative' | 'functional' | 'project' | 'dotted';
};

/** Connector style per reporting-relationship type — the whole point: direct vs dotted etc. */
const LINE: Record<OrgEdge['type'], { labelKey: string; stroke: string; dash?: string }> = {
  administrative: { labelKey: 'legend.direct', stroke: '#6366f1' },
  functional: { labelKey: 'legend.functional', stroke: '#0d9488' },
  project: { labelKey: 'legend.project', stroke: '#9333ea' },
  dotted: { labelKey: 'legend.dotted', stroke: '#d97706', dash: '5 6' },
};

const DEPT_PALETTE = ['#6366f1', '#0d9488', '#d97706', '#db2777', '#0ea5e9', '#65a30d', '#e11d48'];
const deptColor = (d: string | null) =>
  d ? DEPT_PALETTE[[...d].reduce((a, c) => a + c.charCodeAt(0), 0) % DEPT_PALETTE.length] : '#94a3b8';

const Z_MIN = 0.1;
const Z_MAX = 1.5;
const NONE = new Set<string>();

type Pos = { cx: number; cy: number; t: number; b: number; l: number; r: number };

const matchText = (e: OrgEmp) => `${e.employeeCode ?? ''} ${e.name} ${e.role ?? ''} ${e.department ?? ''}`.toLowerCase();

export function OrgChart({ employees, edges, filter, canExport=false }: { employees: OrgEmp[]; edges: OrgEdge[]; filter?:OrgChartFilter;canExport?:boolean }) {
  const t = useTranslations('org');
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

  const [collapsed, setCollapsed] = useState<Set<string>>(()=>employees.length>100?new Set(employees.map(e=>e.employmentId)):new Set());
  const [query, setQuery] = useState('');
  const [scale, setScale] = useState(1);
  const [horizontal,setHorizontal]=useState(false);
  const [quick,setQuick]=useState<OrgEmp|null>(null);
  const [levels,setLevels]=useState(3);
  const [branch,setBranch]=useState('');
  const [exportScope,setExportScope]=useState('current');
  const viewportRef=useRef<HTMLDivElement>(null);
  const quickRef=useRef<HTMLElement>(null);const quickReturnRef=useRef<HTMLElement|null>(null);
  useEffect(()=>{if(!quick)return;const before=quickReturnRef.current;const overflow=document.body.style.overflow;document.body.style.overflow='hidden';const key=(event:KeyboardEvent)=>{if(event.key==='Escape')setQuick(null);if(event.key==='Tab'){const controls=quickRef.current?.querySelectorAll<HTMLElement>('a,button');if(!controls?.length)return;const first=controls[0],last=controls[controls.length-1];if(event.shiftKey&&document.activeElement===first){event.preventDefault();last.focus();}else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first.focus();}}};document.addEventListener('keydown',key);return()=>{document.removeEventListener('keydown',key);document.body.style.overflow=overflow;before?.focus();};},[quick]);
  const pan=useRef<{x:number;y:number;left:number;top:number}|null>(null);
  const stateKey='org-chart-view:'+JSON.stringify(filter??{});
  const applyLevels=(depth:number)=>{const hidden=new Set<string>();const queue=roots.map(root=>({id:root.employmentId,depth:1}));const seen=new Set<string>();for(let i=0;i<queue.length;i++){const node=queue[i];if(seen.has(node.id))continue;seen.add(node.id);if(node.depth>=depth)hidden.add(node.id);else for(const id of childrenByMgr.get(node.id)??[])queue.push({id,depth:node.depth+1});}setCollapsed(hidden);};
  useEffect(()=>{try{const saved=JSON.parse(sessionStorage.getItem(stateKey)??'null');if(saved){setCollapsed(new Set((saved.collapsed??[]).filter((id:string)=>empById.has(id))));setHorizontal(saved.horizontal===true);setQuery(String(saved.query??''));}}catch{/* Ignore invalid session preferences. */}},[stateKey]);
  useEffect(()=>{sessionStorage.setItem(stateKey,JSON.stringify({collapsed:[...collapsed],horizontal,query}));},[stateKey,collapsed,horizontal,query]);


  const q = query.trim().toLowerCase();
  // Searching reveals everything — a match hidden inside a collapsed subtree is useless.
  const effCollapsed = q ? NONE : collapsed;
  const matches = q
    ? new Set(employees.filter((e) => matchText(e).includes(q)).map((e) => e.employmentId))
    : null;

  const pathMatches=q?orgChartSearchIds(employees,edges,q):new Set<string>();
  const shownChildren=q?new Map([...childrenByMgr].map(([id,children])=>[id,children.filter(child=>pathMatches.has(child))])):childrenByMgr;
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
  }, [employees, edges, effCollapsed, scale, horizontal, q]);

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
    const d=orgChartConnectorPath(m,s,e.type,horizontal);
    return [{ key: `${e.manager}-${e.subordinate}-${i}`, d, manager:e.manager,subordinate:e.subordinate,type:e.type,stroke: style.stroke, dash: style.dash }];
  });

  const renderNode = (id: string): ReactNode => {
    const e = empById.get(id);
    if (!e) return null;
    const hit = pathMatches.has(id);
    return (
      <button
        type="button"
        ref={setNode(id)}
        data-org-node={id}
        onClick={event=>{quickReturnRef.current=event.currentTarget;setQuick(e)}}
        className={cn(
          'relative z-10 flex w-52 text-start flex-col gap-2 rounded-2xl border border-border bg-card p-3 shadow-[var(--shadow-card)] transition-colors hover:border-primary',
          hit && 'border-transparent ring-2 ring-primary',
          matches && !hit && 'opacity-50',
        )}
      >
        <div className="flex items-center gap-2.5">
          <Avatar name={e.name} src={e.photoUrl??undefined} className="size-9 text-xs" />
          <div className="min-w-0">
            {/* Employee ID left-of-name (feedback 38668d9b). The name wraps to two lines before it ellipsises
                (r391): one line beside the ID leaves ~70px, which clipped even short names. */}
            <EmployeeName code={e.employeeCode} name={e.name} wrap className="text-sm font-semibold leading-snug text-foreground" />
            <div className="truncate text-xs text-muted-foreground">{e.role ?? '—'}</div>
          </div>
        </div>
        <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <span className="size-2 shrink-0 rounded-full" style={{ background: deptColor(e.department) }} />
          <span className="truncate">{e.department ?? '—'}</span>
        </div>
        <div className="text-xs text-muted-foreground">{t('directReports',{count:e.directReportCount??(childrenByMgr.get(id)??[]).length})}</div>
        {e.topLevel&&<span className="text-xs font-medium">{t('topLevel.tag')}</span>}
        {e.crossCompany&&<span className="text-xs">{t('crossCompany')}</span>}
        {e.status==='probation'&&<span className="text-xs">{t('statuses.probation')}</span>}
        {e.managerState&&<span className="text-xs text-amber-700 dark:text-amber-400">{e.managerState==='outside'?t('outsideFilter',{name:e.managerName??''}):e.managerState==='restricted'?t('restrictedSuperior'):e.managerState==='inactive'?t('vacantSuperior'):t('integrity.'+(e.managerState==='missing'?'unassigned':'invalid'))}</span>}
      </button>
    );
  };

  const zoomBtn =
    'grid size-7 place-items-center rounded-lg border border-border bg-card text-muted-foreground transition duration-150 ease-snappy hover:bg-accent hover:text-foreground active:scale-95 disabled:pointer-events-none disabled:opacity-40';

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-x-5 gap-y-3">
        <div className="flex flex-wrap items-center gap-x-5 gap-y-2 text-xs text-muted-foreground">
          {(Object.keys(LINE) as OrgEdge['type'][]).map((lineType) => (
            <span key={lineType} className="inline-flex items-center gap-2">
              <svg width="22" height="8" aria-hidden className="overflow-visible">
                <line
                  x1="0"
                  y1="4"
                  x2="22"
                  y2="4"
                  stroke={LINE[lineType].stroke}
                  strokeWidth="2"
                  strokeDasharray={LINE[lineType].dash}
                  strokeLinecap="round"
                />
              </svg>
              {t(LINE[lineType].labelKey)}
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
              placeholder={t('searchPlaceholder')}
              aria-label={t('searchAria')}
              className="h-8 w-48 rounded-lg border border-border bg-card pl-8 pr-2 text-sm outline-none transition-colors placeholder:text-muted-foreground focus-visible:border-ring"
            />
          </div>
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={() => setScale((s) => Math.max(Z_MIN, +(s - 0.1).toFixed(1)))}
              disabled={scale <= Z_MIN}
              aria-label={t('zoomOut')}
              className={zoomBtn}
            >
              <Minus className="size-4" />
            </button>
            <button
              type="button"
              onClick={() => setScale(1)}
              title={t('resetZoom')}
              className="h-7 min-w-12 rounded-lg border border-border bg-card px-1.5 text-xs font-medium tabular-nums text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            >
              {Math.round(scale * 100)}%
            </button>
            <button
              type="button"
              onClick={() => setScale((s) => Math.min(Z_MAX, +(s + 0.1).toFixed(1)))}
              disabled={scale >= Z_MAX}
              aria-label={t('zoomIn')}
              className={zoomBtn}
            >
              <Plus className="size-4" />
            </button>
          </div>
        </div>
      </div>

      {matches && matches.size === 0 && (
        <p className="mb-3 text-xs text-muted-foreground">{t('noMatch', { query: query.trim() })}</p>
      )}

      <div className="mb-4 flex flex-wrap items-end gap-2 text-xs">
        <button className="rounded border px-3 py-2" type="button" onClick={()=>setCollapsed(new Set())}>{t('expandAll')}</button>
        <button className="rounded border px-3 py-2" type="button" onClick={()=>setCollapsed(new Set(employees.map(e=>e.employmentId)))}>{t('collapseAll')}</button>
        <label>{t('levels')}<input type="number" min="1" max="50" value={levels} onChange={e=>setLevels(Math.max(1,Math.min(50,Number(e.target.value))))} className="ms-1 w-14 rounded border p-2"/></label><button type="button" className="rounded border px-3 py-2" onClick={()=>applyLevels(levels)}>{t('showLevels')}</button>
        <button type="button" className="rounded border px-3 py-2" onClick={()=>{const view=viewportRef.current;if(view&&box.w)setScale(Math.max(.1,Math.min(1,(view.clientWidth-32)/box.w)));}}>{t('fit')}</button>
        <button type="button" className="rounded border px-3 py-2" onClick={()=>setHorizontal(value=>!value)}>{t(horizontal?'vertical':'horizontal')}</button>
      </div>
      {canExport&&filter&&<form action="/org/export" method="post" className="mb-4 flex flex-wrap items-end gap-2 rounded-lg border p-3 text-xs">
        <input type="hidden" name="filter" value={JSON.stringify({...filter,query})}/><input type="hidden" name="collapsed" value={JSON.stringify([...effCollapsed])}/><input type="hidden" name="horizontal" value={String(horizontal)}/>
        <label>{t('export.scope')}<select name="scope" value={exportScope} onChange={e=>setExportScope(e.target.value)} className="ms-1 rounded border p-2"><option value="current">{t('export.current')}</option><option value="branch">{t('export.branch')}</option></select></label>
        {exportScope==='branch'&&<select name="root" value={branch} onChange={e=>setBranch(e.target.value)} required className="rounded border p-2"><option value="">{t('export.choose')}</option>{employees.map(e=><option key={e.employmentId} value={e.employmentId}>{e.name}</option>)}</select>}
        <select name="paper" aria-label={t('export.paper')} className="rounded border p-2"><option>A4</option><option>A3</option></select>
        <select name="orientation" aria-label={t('export.orientation')} className="rounded border p-2"><option value="landscape">{t('export.landscape')}</option><option value="portrait">{t('export.portrait')}</option></select>
        <select name="pagination" aria-label={t('export.pagination')} className="rounded border p-2"><option value="fit">{t('export.fit')}</option><option value="pages">{t('export.pages')}</option></select>
        <label><input type="checkbox" name="confidential" value="true" defaultChecked/> {t('export.confidential')}</label>
        <button className="rounded bg-primary px-3 py-2 text-primary-foreground">{t('export.button')}</button>
      </form>}
      <div ref={viewportRef} className="max-h-[70vh] overflow-auto pb-2 touch-pan-x touch-pan-y" onPointerDown={e=>{if((e.target as HTMLElement).closest('button,a,input,select'))return;const view=viewportRef.current!;pan.current={x:e.clientX,y:e.clientY,left:view.scrollLeft,top:view.scrollTop};e.currentTarget.setPointerCapture?.(e.pointerId);}} onPointerMove={e=>{if(!pan.current)return;const view=viewportRef.current!;view.scrollLeft=pan.current.left-(e.clientX-pan.current.x);view.scrollTop=pan.current.top-(e.clientY-pan.current.y);}} onPointerUp={()=>{pan.current=null;}} onPointerCancel={()=>{pan.current=null;}}>

        <div
          data-org-wrapper="" className="relative mx-auto"
          style={box.w ? { width: box.w * scale, height: box.h * scale } : undefined}
        >
          <div
            ref={treeRef}
            data-org-tree="" data-org-horizontal={String(horizontal)}
            className="relative w-max px-6 py-2"
            style={{ transform: `scale(${scale})`, transformOrigin: 'top left' }}
          >
            <svg
              data-org-connectors="" className="pointer-events-none absolute left-0 top-0 z-0"
              width={box.w || 1}
              height={box.h || 1}
              fill="none"
            >
              {paths.map((p) => (
                <path
                  key={p.key}
                  data-org-manager={p.manager} data-org-subordinate={p.subordinate} data-org-type={p.type}
                  d={p.d}
                  stroke={p.stroke}
                  strokeWidth="2"
                  strokeDasharray={p.dash}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              ))}
            </svg>
            <div className={cn("relative z-10 flex items-start gap-12",horizontal&&"flex-col")}>
              {[false,true].map(unassigned=>{const group=roots.filter(root=>(!q||pathMatches.has(root.employmentId))&&['missing','inactive','invalid'].includes(root.managerState??'')===unassigned);return group.length?<section key={String(unassigned)} className="space-y-3">{unassigned&&<h3 className="text-sm font-semibold text-muted-foreground">{t('integrity.unassigned')}</h3>}<div className={cn('flex items-start gap-12',horizontal&&'flex-col')}>{group.map(r=><Subtree key={r.employmentId} id={r.employmentId} childrenByMgr={shownChildren} collapsed={effCollapsed} onToggle={toggle} renderNode={renderNode} horizontal={horizontal}/>)}</div></section>:null;})}
            </div>
          </div>
        </div>
      </div>
      {box.w>0&&employees.length>25&&<div className="mt-3"><span className="text-xs text-muted-foreground">{t('minimap')}</span><svg viewBox={`0 0 ${box.w} ${box.h}`} width="180" height="100" className="rounded border bg-muted/30" role="img" aria-label={t('minimap')}>{[...box.pos].map(([id,pos])=><rect key={id} x={pos.l} y={pos.t} width={pos.r-pos.l} height={pos.b-pos.t} fill="currentColor" opacity=".4" onClick={()=>nodeRefs.current.get(id)?.scrollIntoView({block:'nearest',inline:'center'})}/>)}</svg></div>}
      {quick&&createPortal(<div role="dialog" aria-modal="true" aria-label={quick.name} className="fixed inset-0 z-50 grid place-items-center bg-black/30 p-4" onClick={()=>setQuick(null)}><section ref={quickRef} className="w-full max-w-sm space-y-3 rounded-xl border bg-card p-5 shadow-xl" onClick={event=>event.stopPropagation()}><h2 className="font-semibold">{quick.employeeCode} · {quick.name}</h2><p>{quick.role}</p><p className="text-sm text-muted-foreground">{quick.department} · {quick.company}</p><p className="text-sm">{t('directReports',{count:(childrenByMgr.get(quick.employmentId)??[]).length})}</p>{quick.canOpenProfile!==false&&<Link className="block text-sm underline" href={`/personnel/${quick.employmentId}?from=org`}>{t('profile')}</Link>}<button autoFocus type="button" className="rounded border px-3 py-2 text-sm" onClick={()=>setQuick(null)}>{t('close')}</button></section></div>,document.body)}
    </div>
  );
}

function Subtree({
  id,
  childrenByMgr,
  collapsed,
  onToggle,
  renderNode,
  horizontal=false,
}: {
  id: string;
  childrenByMgr: Map<string, string[]>;
  collapsed: Set<string>;
  onToggle: (id: string) => void;
  renderNode: (id: string) => ReactNode;
  horizontal?:boolean;
}) {
  const t = useTranslations('org');
  const kids = childrenByMgr.get(id) ?? [];
  const isCollapsed = collapsed.has(id);
  return (
    <div className={cn("flex items-center",horizontal?"flex-row":"flex-col")}>
      {renderNode(id)}
      {kids.length > 0 && (
        <button
          type="button"
          onClick={() => onToggle(id)}
          aria-expanded={!isCollapsed}
          aria-label={isCollapsed ? t('expandReports', { count: kids.length }) : t('collapseReports')}
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
        <div className={cn("flex items-start gap-10",horizontal?"flex-col ps-10":"pt-10")}>
          {kids.map((k) => (
            <Subtree
              key={k}
              id={k}
              childrenByMgr={childrenByMgr}
              collapsed={collapsed}
              onToggle={onToggle}
              renderNode={renderNode}
              horizontal={horizontal}
            />
          ))}
        </div>
      )}
    </div>
  );
}
