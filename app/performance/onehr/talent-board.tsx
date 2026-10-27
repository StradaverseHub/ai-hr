'use client';
import { useState,type DragEvent,type ReactNode } from 'react';
import { useTranslations } from 'next-intl';
import { ChevronRight,GripVertical } from 'lucide-react';
import { Badge,inputCls } from '@/components/ui';
import { potentialBands,potentialReferenceCurve,talentCategory,type PMBand,type PotentialBand,type Talent } from '@/packs/performance/onehr/model';
import { boardCellKey,boardColumns,boardMove,boardSummary,fixed1,referenceText,talentCategoryOrder,type CapUsage,type TalentBoxGrid } from '@/packs/performance/onehr/talent-board-model';
import type { TalentListFilters,TalentListSort } from '@/packs/performance/onehr/talent-list-model';
import { TalentBoxMove } from './talent-box-move';
import { TalentList } from './talent-list';
import type { CalibrationRosterRow } from './calibration-roster';

type Reference=Partial<Record<PMBand,number>>|null;
export type TalentBoardUnit={id:string;name:string};
export type TalentBoardProps={
 rows:CalibrationRosterRow[];sessionId:string;revision:number;grid:TalentBoxGrid;
 scope:{name:string;cycle:string};locked:boolean;
 units:TalentBoardUnit[];showUnits:boolean;
 /** The whole scope's performance reference; a selected unit may have its own (BG). Absent means no single reference. */
 reference:Reference;unitReferences?:Record<string,Reference>;
 cap:{pct:number;units:Record<string,CapUsage>}|null;
 /** This tier may move people on the box; each chip still honours its own lock and write rights. */
 movable:boolean;
 onOpen?:(id:string)=>void;onMoved?:(id:string)=>void;lastViewed?:string|null;
 footer?:ReactNode;unitFooters?:Record<string,ReactNode>;unitTools?:(unitId:string)=>ReactNode;
 initialUnit?:string;hidden?:boolean;
};
/** Category identity is the word on the cell; the tint only repeats it (the same tints the earlier count grid used). */
const tone=(category:Talent)=>category==='PIP/Improvement'?'bg-amber-50 dark:bg-amber-500/10':category==='Super Star'?'bg-primary/15':category==='Star'?'bg-primary/10':'bg-muted/30';
const grades=(values:string[])=>[...new Set(values.filter(Boolean))].sort((a,b)=>a.localeCompare(b,undefined,{numeric:true,sensitivity:'base'}));

/**
 * The Talent Box board (OneHR talent_box, business-exact inside AI-HR's own components): header counts, unit pills at
 * BG/Group, department and grade filters that re-measure the distribution, 9-box | Table | per-category views, the
 * reference guideline, a grid of draggable name chips, and the existing lock in a sticky footer. Every move goes
 * through the one guarded writer (saveCalibrationBandAction → moveAssessmentTalentBox) with a reason.
 */
export function TalentBoard({rows,sessionId,revision,grid,scope,locked,units,showUnits,reference,unitReferences,cap,movable,onOpen,onMoved,lastViewed=null,footer,unitFooters,unitTools,initialUnit='',hidden=false}:TalentBoardProps){
 const t=useTranslations('onehr.talentBoard'),tr=useTranslations('onehr');
 const [unit,setUnit]=useState(showUnits&&units.some(u=>u.id===initialUnit)?initialUnit:''),[department,setDepartment]=useState(''),[grade,setGrade]=useState(''),[tab,setTab]=useState<'grid'|'table'|Talent>('grid');
 const [details,setDetails]=useState(false),[dragging,setDragging]=useState<string|null>(null),[over,setOver]=useState<string|null>(null),[move,setMove]=useState<{id:string;key:string}|null>(null);
 const [listFilters,setListFilters]=useState<TalentListFilters>({}),[listSort,setListSort]=useState<TalentListSort>({column:'box',direction:-1});
 const singleUnit=!showUnits&&units.length===1?units[0].id:'',activeUnit=unit||singleUnit;
 const inUnit=rows.filter(r=>!unit||r.companyId===unit),filtered=inUnit.filter(r=>(!department||(r.department??'')===department)&&(!grade||r.grade===grade));
 const narrowed=!!(unit||department||grade);
 const activeReference=unit?unitReferences?.[unit]??null:reference;
 const summary=boardSummary(filtered,grid,activeReference),columns=boardColumns(grid);
 const departments=grades(rows.map(r=>r.department??'')),jobGrades=grades(rows.map(r=>r.grade));
 const canMove=(r:CalibrationRosterRow)=>movable&&!locked&&!r.locked&&!r.readOnly&&r.canMove!==false;
 const moving=move?rows.find(r=>r.id===move.id):undefined;
 const columnLabel=(column:string)=>grid===9?t('columnPerformance',{level:tr(`grid${column[0].toUpperCase()+column.slice(1)}`)}):column;
 const capUnits=cap?Object.entries(cap.units).filter(([id])=>!activeUnit||id===activeUnit):[];
 const capUsed=capUnits.reduce((n,[,u])=>n+u.used,0),capTotal=capUnits.reduce((n,[,u])=>n+u.cap,0);
 const open=(id:string)=>{if(onOpen)onOpen(id);else document.getElementById(`assessment-${id}`)?.scrollIntoView({block:'start'});};
 function drop(event:DragEvent,key:string){
  event.preventDefault();setOver(null);
  const id=event.dataTransfer?.getData('text/plain')||dragging;setDragging(null);
  const person=rows.find(r=>r.id===id);if(!person||!canMove(person)||boardCellKey(person,grid)===key)return;
  setMove({id:person.id,key});
 }
 const chip=(r:CalibrationRosterRow)=>{
  const direction=boardMove(r,grid),movableChip=canMove(r);
  const from=direction&&r.from?.performance&&r.from.potential?talentCategory(r.from.performance,r.from.potential):null;
  return <li key={r.id} draggable={movableChip} onDragStart={event=>{event.dataTransfer?.setData('text/plain',r.id);if(event.dataTransfer)event.dataTransfer.effectAllowed='move';setDragging(r.id);}} onDragEnd={()=>{setDragging(null);setOver(null);}} data-board-person={r.id} className={`flex min-w-0 items-center gap-1 rounded-md border border-border bg-card px-1 text-sm ${lastViewed===r.id?'ring-1 ring-primary':''} ${dragging===r.id?'opacity-50':''}`}>
   {movableChip&&<GripVertical aria-hidden className="size-3.5 shrink-0 cursor-grab text-muted-foreground"/>}
   <button type="button" onClick={()=>open(r.id)} title={`${r.name} · ${r.performance??'—'} · ${r.potential??'—'}`} className="min-h-9 min-w-0 flex-1 truncate text-left text-primary hover:underline">{r.name}</button>
   {direction&&<span className="shrink-0 text-xs font-semibold" title={t(direction==='up'?'movedUp':'movedDown',{category:from??''})}><span aria-hidden>{direction==='up'?'↗':'↘'}</span><span className="sr-only">{t(direction==='up'?'movedUp':'movedDown',{category:from??''})}</span></span>}
   {movableChip&&<button type="button" aria-label={t('moveTo',{name:r.name})} onClick={()=>setMove({id:r.id,key:''})} className="min-h-9 shrink-0 rounded px-1.5 text-xs text-muted-foreground hover:bg-muted hover:text-foreground">{t('moveMenu')}</button>}
  </li>;
 };
 const categoryTable=(category:Talent)=>{const members=filtered.filter(r=>talentCategory(r.performance,r.potential)===category).sort((a,b)=>a.name.localeCompare(b.name)||a.id.localeCompare(b.id));
  return <section aria-label={category} className="space-y-2 px-5"><p className="text-xs text-muted-foreground">{t('categoryHelp',{category})}</p>{members.length?<div className="overflow-x-auto border-y border-border"><table className="w-full min-w-[36rem] text-sm"><caption className="sr-only">{category}</caption><thead className="bg-muted/30 text-left text-xs text-muted-foreground"><tr><th scope="col" className="p-2">{tr('talentList.columns.name')}</th><th scope="col" className="p-2">{tr('talentList.columns.department')}</th><th scope="col" className="p-2">{tr('talentList.columns.grade')}</th><th scope="col" className="p-2">{tr('performance')}</th><th scope="col" className="p-2">{tr('potential')}</th>{movable&&!locked&&<th scope="col" className="p-2"><span className="sr-only">{tr('talentList.actions')}</span></th>}</tr></thead><tbody>{members.map(r=><tr key={r.id} className="border-t border-border"><th scope="row" className="p-2 text-left font-normal"><button type="button" onClick={()=>open(r.id)} className="min-h-11 text-left font-medium text-primary hover:underline">{r.name}</button></th><td className="p-2">{r.department||'—'}</td><td className="p-2 tabular-nums">{r.grade||'—'}</td><td translate="no" className="p-2">{r.performance??'—'}</td><td translate="no" className="p-2">{r.potential??'—'}</td>{movable&&!locked&&<td className="p-2">{canMove(r)&&<button type="button" aria-label={t('moveTo',{name:r.name})} onClick={()=>setMove({id:r.id,key:''})} className="min-h-11 text-sm text-primary hover:underline">{t('moveMenu')}</button>}</td>}</tr>)}</tbody></table></div>:<p className="py-6 text-sm text-muted-foreground">{t('categoryEmpty',{category})}</p>}</section>;};
 const tabs:{id:'grid'|'table'|Talent;label:string;count?:number}[]=[{id:'grid',label:t(grid===9?'grid9':'grid15')},{id:'table',label:t('table')},...talentCategoryOrder.map(category=>({id:category,label:category,count:summary.categoryCounts[category]}))];
 const moves=summary.deltas.filter(d=>d.delta!==0);
 return <section hidden={hidden} aria-label={t('title')} className="space-y-4 pb-2">
  <header className="space-y-2 px-5 pt-4">
   <p className="text-xs text-muted-foreground">{t('title')}</p><h2 className="text-lg font-semibold">{scope.name}</h2>
   <div className="flex flex-wrap items-center gap-2 text-xs"><span className="rounded-md border border-border px-2 py-0.5">{t('people',{count:filtered.length})}</span><span className="rounded-md border border-border px-2 py-0.5">{t('units',{count:new Set(filtered.map(r=>r.companyId)).size})}</span><span className="rounded-md border border-border px-2 py-0.5">{t('placed',{placed:summary.placed,total:filtered.length})}</span><Badge variant={locked?'success':'info'}>{t(locked?'lockedState':'openState')}</Badge></div>
   <p className="text-xs text-muted-foreground">{t('sources',{cycle:scope.cycle})}</p>
  </header>
  {showUnits&&units.length>1&&<div role="group" aria-label={t('businessUnit')} className="flex min-w-0 items-center gap-2 overflow-x-auto px-5"><span className="shrink-0 text-xs text-muted-foreground">{t('businessUnit')}</span>{[{id:'',name:t('all'),count:rows.length},...units.map(u=>({...u,count:rows.filter(r=>r.companyId===u.id).length}))].map(u=><button type="button" key={u.id||'all'} aria-pressed={unit===u.id} onClick={()=>{setUnit(u.id);setDepartment('');setGrade('');}} className={`min-h-9 shrink-0 whitespace-nowrap rounded-full border px-3 text-sm ${unit===u.id?'border-primary bg-primary/10 font-medium':'border-border hover:bg-muted'}`}>{u.name} <span className="text-xs text-muted-foreground">{u.count}</span></button>)}</div>}
  <div className="mx-5 space-y-2 rounded-lg border border-border p-3">
   <div className="flex flex-wrap items-end gap-3"><label className="min-w-40 text-xs font-medium">{t('department')}<select value={department} onChange={e=>setDepartment(e.target.value)} className={`${inputCls} mt-1`}><option value="">{t('allDepartments')}</option>{departments.map(d=><option key={d} value={d}>{d}</option>)}</select></label><label className="min-w-32 text-xs font-medium">{t('grade')}<select value={grade} onChange={e=>setGrade(e.target.value)} className={`${inputCls} mt-1`}><option value="">{t('allGrades')}</option>{jobGrades.map(g=><option key={g} value={g}>{g}</option>)}</select></label>{(department||grade)&&<button type="button" onClick={()=>{setDepartment('');setGrade('');}} className="min-h-11 px-2 text-sm text-primary">{t('clearFilters')}</button>}{activeUnit&&unitTools&&<div className="ml-auto flex flex-wrap items-center gap-2">{unitTools(activeUnit)}</div>}</div>
   <p className="text-xs text-muted-foreground">{narrowed?t('filtered',{count:filtered.length}):t('wholeScope')}</p>
  </div>
  <div role="tablist" aria-label={t('views')} className="flex min-w-0 gap-1 overflow-x-auto border-b border-border px-5">{tabs.map(item=><button type="button" role="tab" key={item.id} id={`talent-board-tab-${item.id}`} aria-selected={tab===item.id} aria-controls={`talent-board-panel-${item.id}`} onClick={()=>setTab(item.id)} className={`-mb-px min-h-11 shrink-0 whitespace-nowrap border-b-2 px-3 text-sm ${tab===item.id?'border-primary font-semibold':'border-transparent text-muted-foreground hover:text-foreground'}`}>{item.label}{item.count!=null&&<span className="ml-1 text-xs text-muted-foreground">{item.count}</span>}</button>)}</div>
  <div role="tabpanel" id={`talent-board-panel-${tab}`} aria-labelledby={`talent-board-tab-${tab}`} className="space-y-4">
  {tab==='grid'&&<>
   <section aria-label={t('referenceTitle')} className="mx-5 rounded-lg border border-border">
    <button type="button" aria-expanded={details} onClick={()=>setDetails(!details)} className="flex min-h-11 w-full flex-wrap items-center gap-2 px-3 py-2 text-left">
     <ChevronRight aria-hidden className={`size-4 shrink-0 transition-transform ${details?'rotate-90':''}`}/><span className="text-sm font-semibold">{t('referenceTitle')}</span>
     {summary.hasReference&&(moves.length?moves.map(d=><span key={d.category} title={t('deltaTitle',{actual:d.actual,target:d.target})} className="rounded-full border border-border px-2 py-0.5 text-xs">{d.category} <b className="tabular-nums">{d.delta>0?`+${d.delta}`:`−${-d.delta}`}</b></span>):<span className="rounded-full border border-border px-2 py-0.5 text-xs">{t('onTarget')}</span>)}
     {cap&&<span className="rounded-full border border-border px-2 py-0.5 text-xs">{capUnits.length===1?t('capChip',{used:capUsed,cap:capTotal}):t('capChipUnits',{used:capUsed,cap:capTotal,count:capUnits.length})}</span>}
     <span className="ml-auto text-xs text-primary">{t(details?'hideDetails':'showDetails')}</span>
    </button>
    {details&&<div className="space-y-2 border-t border-border p-3 text-sm">
     {summary.hasReference?<><p className="text-xs text-muted-foreground">{t('referenceNote',{high:potentialReferenceCurve.High,mid:potentialReferenceCurve.Mid,low:potentialReferenceCurve.Low,placed:summary.placed})}</p>
      <div className="overflow-x-auto"><table className="w-full min-w-[28rem] text-sm"><caption className="sr-only">{t('referenceTitle')}</caption><thead className="text-left text-xs text-muted-foreground"><tr><th scope="col" className="p-1">{t('columns.category')}</th><th scope="col" className="p-1 text-right">{t('columns.count')}</th><th scope="col" className="p-1 text-right">{t('columns.share')}</th><th scope="col" className="p-1 text-right">{t('columns.reference')}</th><th scope="col" className="p-1 text-right">{t('columns.toMove')}</th></tr></thead>
       <tbody>{summary.deltas.map(d=>{const refPct=summary.cells.filter(c=>c.category===d.category).reduce((n,c)=>n+(c.reference??0),0);return <tr key={d.category} className="border-t border-border"><th scope="row" className="p-1 text-left font-normal">{d.category}</th><td className="p-1 text-right tabular-nums">{d.actual}</td><td className="p-1 text-right tabular-nums">{fixed1(summary.placed?d.actual/summary.placed*100:0)}%</td><td className="p-1 text-right tabular-nums">{referenceText(Math.round(refPct*100)/100)}%</td><td className="p-1 text-right tabular-nums">{d.delta>0?`+${d.delta}`:d.delta<0?`−${-d.delta}`:t('onTargetShort')}</td></tr>;})}</tbody></table></div></>
      :<p className="text-xs text-muted-foreground">{t('noReference')}</p>}
     {cap&&<p className="text-xs text-muted-foreground">{t('capNote',{pct:cap.pct})}</p>}
    </div>}
   </section>
   <div className="space-y-1 px-5">
    <p className="text-xs font-medium text-muted-foreground">{t('potentialAxis')}</p>
    <div className="overflow-x-auto"><div className={`grid gap-2 ${grid===9?'min-w-[42rem] grid-cols-[2rem_repeat(3,minmax(0,1fr))]':'min-w-[60rem] grid-cols-[2rem_repeat(5,minmax(0,1fr))]'}`}>
     {[...potentialBands].reverse().map(potential=><div key={potential} className="contents"><span className="flex items-center justify-center text-xs font-medium text-muted-foreground [writing-mode:vertical-rl] rotate-180">{potential}</span>{summary.cells.filter(c=>c.potential===potential).map(cell=>{
      const members=[...cell.members].sort((a,b)=>Number(!!boardMove(b,grid))-Number(!!boardMove(a,grid))||a.name.localeCompare(b.name)||a.id.localeCompare(b.id));
      const droppable=dragging!=null&&boardCellKey(rows.find(r=>r.id===dragging)??{performance:null,potential:null},grid)!==cell.key;
      return <div key={cell.key} role="group" data-board-cell={cell.key} aria-label={t('cellLabel',{category:cell.category,potential,performance:columnLabel(cell.column),count:cell.count})} onDragOver={event=>{if(!droppable)return;event.preventDefault();if(event.dataTransfer)event.dataTransfer.dropEffect='move';setOver(cell.key);}} onDragLeave={()=>setOver(o=>o===cell.key?null:o)} onDrop={event=>drop(event,cell.key)} className={`flex min-h-40 min-w-0 flex-col rounded-md border ${tone(cell.category)} ${over===cell.key?'border-primary ring-2 ring-primary':'border-border'}`}>
       <div className="flex flex-wrap items-baseline justify-between gap-1 border-b border-border px-2 py-1"><span className="text-[11px] font-semibold uppercase tracking-wide">{cell.category}</span><span className="text-xs tabular-nums"><b>{cell.count}</b> · {fixed1(cell.pct)}%{cell.reference!=null&&<span className="text-muted-foreground"> · {t('vsRef',{pct:referenceText(cell.reference)})}</span>}</span></div>
       <ul className={`grid max-h-64 min-h-0 flex-1 content-start gap-1 overflow-y-auto p-1.5 ${grid===9?'sm:grid-cols-2':''}`}>{members.map(chip)}</ul>
      </div>;
     })}</div>)}
     <span/>{columns.map(column=>{const count=summary.cells.filter(c=>c.column===column).reduce((n,c)=>n+c.count,0);return <p key={column} className="text-center text-xs font-medium">{columnLabel(column)}<span className="block font-normal text-muted-foreground">{count}{summary.placed?` · ${Math.round(count/summary.placed*100)}%`:''}</span></p>;})}
    </div></div>
    <p className="text-center text-xs font-medium text-muted-foreground">{t('performanceAxis')}</p>
    <p className="flex flex-wrap gap-4 text-xs text-muted-foreground"><span><span aria-hidden>↗</span> {t('legendUp')}</span><span><span aria-hidden>↘</span> {t('legendDown')}</span></p>
   </div>
  </>}
  {tab==='table'&&<TalentList rows={filtered} filters={listFilters} sort={listSort} onFilters={setListFilters} onSort={setListSort} onSelect={open} category="" lastViewed={lastViewed} active={!hidden&&tab==='table'} unitId={activeUnit} move={movable&&!locked?{sessionId,revision,grid,onMoved}:undefined}/>}
  {tab!=='grid'&&tab!=='table'&&categoryTable(tab)}
  </div>
  <footer className="sticky bottom-0 z-10 flex flex-wrap items-center justify-between gap-3 border-t border-border bg-card px-5 py-3">
   <p className="text-xs text-muted-foreground">{locked?t('footerLocked',{scope:scope.name}):t('footerOpen',{placed:summary.placed,filtered:narrowed?'yes':'no',scope:scope.name})}</p>
   {!locked&&<div className="flex flex-wrap items-center gap-2">{unitFooters&&activeUnit?unitFooters[activeUnit]:footer??(unitFooters?<span className="text-xs text-muted-foreground">{t('pickUnitToLock')}</span>:null)}</div>}
  </footer>
  {moving&&move&&<TalentBoxMove key={`${move.id}.${move.key}`} person={moving} sessionId={sessionId} revision={revision} grid={grid} open onOpenChange={next=>{if(!next)setMove(null);}} initialKey={move.key} trigger={false} onMoved={()=>onMoved?.(moving.id)}/>}
 </section>;
}
