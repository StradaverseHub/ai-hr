'use client';
import {CalibrationPersonDetail} from './calibration-person-detail';
import type {WorkspaceAxis} from '@/packs/performance/onehr/workspace-model';
import {TalentPerson,type TalentPersonTab} from './talent-person';
import {flushAssessmentDrafts} from './draft-form';
import { WrittenRemarks } from './written-remarks';
import { PotentialInsight } from './potential-insight';
import { useEffect,useRef,useState,type ReactNode } from 'react';
import { useTranslations } from 'next-intl';
import * as Dialog from '@radix-ui/react-dialog';
import { pmBands,potentialBands,tiers as calibrationTiers,type PMBand,type PotentialBand } from '@/packs/performance/onehr/model';
import { PerformanceInsight } from './performance-insight';
import type { PerformanceInsight as Insight } from '@/packs/performance/onehr/performance-insight-model';
import {CalibrationFit} from './calibration-fit';
import { CalibrationCurveDialog } from './calibration-curve-dialog';
import { calibrationDistribution,profitAchievementText,type CalibrationCurvePolicy,type profitCurveFor } from '@/packs/performance/onehr/calibration-curve-model';
import type { TalentTrailStep } from '@/packs/performance/onehr/talent-trail-model';
import type { CapUsage,TalentBoxGrid } from '@/packs/performance/onehr/talent-board-model';
import { TalentBoard } from './talent-board';
import { inputCls } from '@/components/ui';
import { ConfirmSubmit } from '@/components/ui/confirm-submit';
import { agreeDepartmentAction } from '../onehr-actions';

export type CalibrationRosterRow={id:string;name:string;grade:string;companyId:string;company:string;department?:string;bandTrails?:{performance:TalentTrailStep[];potential:TalentTrailStep[]};fromCategory?:string|null;from?:{performance:PMBand|null;potential:PotentialBand|null}|null;performance:PMBand|null;potential:PotentialBand|null;performanceSource:string|null;potentialSource:string|null;locked:boolean;moved?:boolean;readOnly?:boolean;canMove?:boolean;journey:{tier:string;performance:PMBand|null;potential:PotentialBand|null}[];potentialPct:number|null};
/** What the Talent Box board needs beyond the roster: layout, scope words, lock state, references and the lock action. */
export type CalibrationBoard={grid:TalentBoxGrid;scope:{name:string;cycle:string};tier?:string;locked:boolean;showUnits:boolean;reference:Partial<Record<PMBand,number>>|null;unitReferences?:Record<string,Partial<Record<PMBand,number>>|null>;cap:{pct:number;units:Record<string,CapUsage>}|null;movable:boolean;footer?:ReactNode};
/** Department/BU use a compact roster. The Talent Box tiers read the board, opening one person in place of it. */
export function CalibrationRoster({rows,cards,detail,axes,grid,reference,board,talentInsight=false,initialFocus=null,agree,sessionId,revision,curves,unitActions,allowFit=false,fitAxes={pm:true,pot:true}}:{fitAxes?:{pm:boolean;pot:boolean};allowFit?:boolean;talentInsight?:boolean;curves?:{policy:CalibrationCurvePolicy;units:{id:string;name:string;profit:ReturnType<typeof profitCurveFor>}[]};unitActions?:{id:string;node:ReactNode}[];sessionId:string;revision:number;agree?:{sessionId:string;revision:number;axis:'performance'|'potential';returnTo?:string;eligibleIds:string[]};initialFocus?:string|null;rows:CalibrationRosterRow[];cards?:{id:string;content:ReactNode}[];detail?:{axis:WorkspaceAxis;returnTo?:string};axes:{pm:boolean;pot:boolean};grid:boolean;reference:Partial<Record<PMBand|PotentialBand,number>>;board?:CalibrationBoard}){
 const unitOptions=[...new Map(rows.map(r=>[r.companyId,r.company])).entries()].sort((a,b)=>a[1].localeCompare(b[1]));
 const t=useTranslations('onehr'),[company,setCompany]=useState(''),[query,setQuery]=useState(''),[band,setBand]=useState(''),[focus,setFocus]=useState<string|null>(initialFocus);
 const [readInsight,setReadInsight]=useState(false),[lastViewed,setLastViewed]=useState<string|null>(null);
 const [personTab,setPersonTab]=useState<TalentPersonTab>('summary'),[navigationError,setNavigationError]=useState('');
 const personPanel=useRef<HTMLElement>(null);
 const [selection,setSelection]=useState<{revision:number;ids:string[]}>({revision,ids:[]}),[verdicts,setVerdicts]=useState<Record<string,{revision:number;verdict:Insight['verdict']}>>({});
 const picked=selection.revision===revision?selection.ids:[];
 const setPicked=(ids:string[])=>setSelection({revision,ids});
 const returnFocus=useRef<HTMLElement|null>(null),roster=useRef<HTMLElement>(null);
 const curveText=useTranslations('onehr.talentCurve');
 const axis=axes.pm?'performance':'potential',bands=axis==='performance'?pmBands:potentialBands;
 const units=unitOptions;
 const unitRows=rows.filter(r=>grid||!company||r.companyId===company).sort((a,b)=>a.name.localeCompare(b.name)||a.id.localeCompare(b.id));
 const visible=grid?unitRows:unitRows.filter(r=>(!query||`${r.name} ${r.grade}`.toLocaleLowerCase().includes(query.toLocaleLowerCase()))&&(!band||r[axis]===band));
 const person=rows.find(r=>r.id===focus),position=visible.findIndex(r=>r.id===focus);
 const presentTiers=new Set(rows.flatMap(r=>r.journey.map(j=>j.tier))),tiers=['self','manager',...calibrationTiers].filter(tier=>presentTiers.has(tier));
 /** The selected unit's read-only axis curves and profit figure, beside the board's filters. */
 function unitTools(unitId:string){
  const unit=curves?.units.find(u=>u.id===unitId);if(!curves||!unit)return null;
  const people=rows.filter(r=>r.companyId===unitId);
  const curve=(curveAxis:'performance'|'potential',vertical=false)=><CalibrationCurveDialog axis={curveAxis} unit={unit.name} distribution={calibrationDistribution(people,curveAxis,curves.policy,unit.profit.reference)} profit={curveAxis==='performance'?unit.profit:undefined} vertical={vertical} fit={allowFit?{sessionId,companyId:unit.id,disabled:!(curveAxis==='performance'?fitAxes.pm:fitAxes.pot)||people.every(r=>r.locked||r.readOnly)}:undefined}/>;
  return <><p className="text-xs text-muted-foreground">{unit.profit.entered?curveText(unit.profit.source==='bg'?'groupFigure':'figure',{value:profitAchievementText(unit.profit.achievementPct)}):curveText('unentered')}</p>{curve('performance')}{curve('potential',true)}</>;
 }

 function navigatePerson(change:()=>void){if(!talentInsight){change();return;}void flushAssessmentDrafts().then(()=>{setNavigationError('');change();}).catch(()=>setNavigationError(t('talentPerson.failed')));}
 function open(id:string,insight=false){navigatePerson(()=>{returnFocus.current=document.activeElement instanceof HTMLElement?document.activeElement:null;setReadInsight(insight);setFocus(id);if(grid)roster.current?.closest('[data-review-scroll]')?.scrollTo?.({top:0});});}
 useEffect(()=>{if(!grid||!focus)return;const show=()=>personPanel.current?.focus({preventScroll:true});if(typeof requestAnimationFrame==='function'){const frame=requestAnimationFrame(show);return()=>cancelAnimationFrame(frame);}show();},[grid,focus]);
 useEffect(()=>{
  if(!grid)return;
  // A review-navigator or chat link to one person opens them in place of the board.
  const navigate=(event:MouseEvent)=>{
   if(event.button!==0||event.ctrlKey||event.metaKey||event.shiftKey||event.altKey)return;
   const anchor=event.target instanceof Element?event.target.closest<HTMLAnchorElement>('a[href^="#assessment-"]'):null;
   const id=anchor?.getAttribute('href')?.slice('#assessment-'.length),row=rows.find(r=>r.id===id);if(!row)return;
   event.preventDefault();open(row.id);
  };
  document.addEventListener('click',navigate);return()=>document.removeEventListener('click',navigate);
 },[grid,rows]);
 const eligible=visible.filter(r=>agree?.eligibleIds.includes(r.id)&&!r.locked);
 const verdict=(id:string)=>{const cached=verdicts[id];return cached?.revision===revision?cached?.verdict??null:null;};
 const count=(code:string)=>unitRows.filter(r=>r[axis]===code).length;
 function close(){navigatePerson(()=>{
  const closed=focus;
  if(closed)setLastViewed(closed);
  setFocus(null);
  if(grid&&closed){const restore=()=>{const target=returnFocus.current?.isConnected&&returnFocus.current.getClientRects().length>0?returnFocus.current:roster.current?.querySelector<HTMLButtonElement>(`[data-board-person="${closed}"] button`);target?.focus({preventScroll:true});};if(typeof requestAnimationFrame==='function')requestAnimationFrame(restore);else setTimeout(restore,0);}
 });}
 const personHeader=<div className="sticky top-0 z-10 flex min-w-0 flex-wrap items-center justify-between gap-2 border-b border-border bg-card px-5 py-2"><h2 className="min-w-0 truncate font-semibold">{person?.name}</h2><div className="flex shrink-0 gap-1"><button type="button" disabled={position<=0} onClick={()=>{const row=visible[position-1];if(row)open(row.id);}} className="min-h-11 rounded-md px-3 text-sm hover:bg-muted disabled:opacity-40">{t('calibrationRoster.previous')}</button><button type="button" disabled={position<0||position>=visible.length-1} onClick={()=>{const row=visible[position+1];if(row)open(row.id);}} className="min-h-11 rounded-md px-3 text-sm hover:bg-muted disabled:opacity-40">{t('calibrationRoster.next')}</button><button type="button" onClick={close} className="min-h-11 rounded-md px-3 text-sm hover:bg-muted">{t(grid?'calibrationRoster.backToBox':'calibrationRoster.close')}</button></div></div>;
 const selectedCard=focus&&(detail?<CalibrationPersonDetail key={`${focus}.${revision}`} sessionId={sessionId} reviewId={focus} revision={revision} axis={detail.axis} returnTo={detail.returnTo}/>:cards?.find(c=>c.id===focus)?.content);
 const personBody=<>{navigationError&&<p role="alert" className="p-4 text-sm text-destructive">{navigationError}</p>}{focus&&person&&talentInsight?<TalentPerson key={`${focus}.${revision}`} reviewId={focus} sessionId={sessionId} person={person} tab={personTab} onTab={tab=>{setPersonTab(tab);personPanel.current?.scrollTo?.({top:0});}}>{selectedCard}</TalentPerson>:<>{focus&&axes.pm&&<div className="px-5 pt-4"><PerformanceInsight reviewId={focus} contextId={sessionId} initialOpen={readInsight} onResult={data=>setVerdicts(old=>({...old,[focus]:{revision,verdict:data?.verdict??null}}))}/></div>}{focus&&axes.pot&&<div className="px-5 pt-4"><PotentialInsight key={focus} reviewId={focus} sessionId={sessionId}/></div>}{focus&&<div className="space-y-3 px-5 pt-4">{axes.pm&&<WrittenRemarks key={`${focus}.pm`} reviewId={focus} sessionId={sessionId} axis="pm"/>}{axes.pot&&<WrittenRemarks key={`${focus}.pot`} reviewId={focus} sessionId={sessionId} axis="pot"/>}</div>}{focus&&selectedCard}</>}</>;
 if(grid){
  const layout:CalibrationBoard=board??{grid:9,scope:{name:t('calibrationRoster.talentBox'),cycle:''},locked:false,showUnits:units.length>1,reference:null,cap:null,movable:false};
  return <section ref={roster} className="space-y-4" aria-label={t('calibrationRoster.title')}>
   <TalentBoard hidden={focus!=null} rows={rows} sessionId={sessionId} revision={revision} grid={layout.grid} scope={layout.scope} tier={layout.tier} locked={layout.locked} units={units.map(([id,name])=>({id,name}))} showUnits={layout.showUnits} reference={layout.reference} unitReferences={layout.unitReferences} cap={layout.cap} movable={layout.movable} onOpen={id=>open(id)} onMoved={setLastViewed} lastViewed={lastViewed} footer={layout.footer} unitFooters={unitActions?Object.fromEntries(unitActions.map(action=>[action.id,action.node])):undefined} unitTools={curves?unitTools:undefined} initialUnit={rows.find(r=>r.id===initialFocus)?.companyId}/>
   {focus&&<section ref={personPanel} aria-label={person?.name} tabIndex={-1} onKeyDown={e=>{if(e.key==='Escape')close();}} className="mx-5 min-w-0 scroll-pt-24 rounded-lg border border-border">{personHeader}{personBody}</section>}
  </section>;
 }
 return <section ref={roster} className="space-y-4" aria-label={t('calibrationRoster.title')}>
  <div className="flex flex-wrap items-end gap-3 px-5 pt-1">
   {units.length>1&&<label className="min-w-0 flex-1 text-xs font-medium">{t('company')}<select value={company} onChange={e=>{setCompany(e.target.value);setBand('');setPicked([]);}} className={`${inputCls} mt-1`}><option value="">{t('calibrationRoster.allUnits')}</option>{units.map(([id,name])=><option key={id} value={id}>{name}</option>)}</select></label>}
   <label className="min-w-0 flex-1 text-xs font-medium">{t('calibrationRoster.search')}<input type="search" value={query} onChange={e=>{setQuery(e.target.value);setPicked([]);}} className={`${inputCls} mt-1`}/></label>
  </div>
  <div className="flex flex-wrap gap-2 px-5" aria-label={t('calibrationRoster.distribution')}>
   {allowFit&&<CalibrationFit key={`${sessionId}.${axis}.${company}`} sessionId={sessionId} axis={axis} companyId={company||null} disabled={!(axis==='performance'?fitAxes.pm:fitAxes.pot)||unitRows.every(r=>r.locked||r.readOnly)}/>}
   <button type="button" aria-pressed={!band} onClick={()=>{setBand('');setPicked([]);}} className="min-h-11 rounded-md border border-border px-3 text-sm">{t('calibrationRoster.allBands')} · {unitRows.length}</button>
   {bands.map(code=><button type="button" key={code} aria-pressed={band===code} onClick={()=>{setBand(band===code?'':code);setPicked([]);}} className={`min-h-11 rounded-md border px-3 py-2 text-sm ${band===code?'border-primary bg-primary/5':'border-border'}`}><b translate="no">{code}</b> · {count(code)} <span className="ml-1 text-xs text-muted-foreground">({unitRows.length?Math.round(count(code)/unitRows.length*100):0}%{reference[code]!=null&&<> / {reference[code]}%</>})</span></button>)}
  </div>
  <form action={agree?agreeDepartmentAction:undefined}>
   {agree&&<><input type="hidden" name="sessionId" value={agree.sessionId}/><input type="hidden" name="revision" value={agree.revision}/><input type="hidden" name="axis" value={agree.axis}/>{agree.returnTo&&<input type="hidden" name="returnTo" value={agree.returnTo}/>}</>}
  <div role="region" aria-label={t('calibrationRoster.title')} tabIndex={0} className="overflow-x-auto border-y border-border">
   <table className="w-full min-w-[42rem] table-fixed border-collapse text-sm"><caption className="sr-only">{t('calibrationRoster.title')}</caption><thead className="bg-muted/30 text-xs text-muted-foreground"><tr>{agree&&<th scope="col" className="w-12 p-2"><input type="checkbox" aria-label={t('calibrationRoster.selectAll')} disabled={!eligible.length} checked={eligible.length>0&&eligible.every(r=>picked.includes(r.id))} onChange={e=>setPicked(e.target.checked?eligible.map(r=>r.id):[])}/></th>}<th scope="col" className="w-56 p-3 text-left">{t('calibrationRoster.person')}</th>{axes.pm&&<th scope="col" className="w-28 p-2">{t('moderationTable.justified')}</th>}{!axes.pm&&<th scope="col" className="w-24 p-2">{t('calibrationRoster.potentialScore')}</th>}{tiers.map(tier=><th key={tier} scope="col" className="w-20 p-2">{tier==='self'?t('calibrationRoster.self'):tier==='manager'?t('calibrationRoster.lineManager'):t(`tiers.${tier}`)}</th>)}<th scope="col" className="w-24 p-2">{t('calibrationRoster.current')}</th><th scope="col" className="w-24 p-2">{t('calibrationRoster.status')}</th></tr></thead>
    <tbody>{visible.map(r=><tr key={r.id} id={`assessment-${r.id}`} className="border-t border-border hover:bg-muted/20">{agree&&<td className="p-2 text-center"><input type="checkbox" name="reviewId" value={r.id} aria-label={t('calibrationRoster.agreePerson',{name:r.name})} disabled={r.locked||!agree.eligibleIds.includes(r.id)} checked={picked.includes(r.id)} onChange={e=>setPicked(e.target.checked?[...picked,r.id]:picked.filter(id=>id!==r.id))}/></td>}<th scope="row" className="p-2 text-left font-normal"><button type="button" aria-label={r.name} onClick={()=>open(r.id)} title={r.name} className="block min-h-11 w-full text-left underline-offset-4 hover:underline"><span className="block truncate font-medium text-primary">{r.name}</span><span className="block truncate text-xs text-muted-foreground" title={`${r.company} · ${r.grade}`}>{r.company} · {r.grade}</span></button></th>{axes.pm&&<td className="p-2 text-center text-xs"><button type="button" onClick={()=>open(r.id)} className="min-h-11 w-full text-primary underline-offset-4 hover:underline">{verdict(r.id)?t(`insight.verdict.${verdict(r.id)}`):t(r.journey.some(j=>j.tier==='self'&&j.performance)?'calibrationRoster.notRead':'calibrationRoster.notFinal')}</button></td>}{!axes.pm&&<td className="p-2 text-center tabular-nums">{r.potentialPct==null?'—':`${Math.round(r.potentialPct)}%`}</td>}{tiers.map(tier=>{const value=r.journey.find(j=>j.tier===tier);return <td key={tier} translate="no" className="p-2 text-center">{axes.pm?value?.performance??'—':value?.potential??'—'}{axes.pm&&axes.pot&&<span className="block text-xs text-muted-foreground">{value?.potential??'—'}</span>}</td>;})}<td translate="no" className="p-2 text-center font-semibold">{r[axis]??'—'}{(axis==='performance'?r.performanceSource:r.potentialSource)==='default'&&<span className="block text-xs font-normal text-muted-foreground">{t('calibrationRoster.provisional')}</span>}{axes.pm&&axes.pot&&<span className="block text-xs">{r.potential??'—'}</span>}</td><td className="p-2 text-center text-xs text-muted-foreground">{t(r.locked?'locked':r.readOnly?'calibrationRoster.readOnly':'calibrationRoster.open')}</td></tr>)}</tbody>
   </table>{!visible.length&&<p className="px-5 py-8 text-sm text-muted-foreground">{t('calibrationRoster.empty')}</p>}
  </div>
   {agree&&<div className="flex justify-end px-5 py-3"><ConfirmSubmit disabled={!picked.length} variant="secondary" description={t('calibrationRoster.agreeConfirm')}>{t('calibrationRoster.agreeSelected',{count:picked.length})}</ConfirmSubmit></div>}
  </form>
  <Dialog.Root open={focus!=null} onOpenChange={open=>{if(!open)close();}}><Dialog.Portal><Dialog.Overlay className="fixed inset-0 z-40 bg-black/40"/><Dialog.Content aria-describedby={undefined} onCloseAutoFocus={e=>{e.preventDefault();if(returnFocus.current?.isConnected)returnFocus.current.focus();else roster.current?.querySelector<HTMLInputElement>('input[type=search]')?.focus();}} className="fixed left-1/2 top-1/2 z-40 max-h-[90dvh] w-[calc(100%_-_2rem)] max-w-4xl -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-lg border border-border bg-card p-0 text-foreground shadow-xl">
   <Dialog.Title className="sr-only">{person?.name}</Dialog.Title>{personHeader}{personBody}
  </Dialog.Content></Dialog.Portal></Dialog.Root>
 </section>;
}
