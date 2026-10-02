'use client';

import {useEffect,useRef,useState} from 'react';
import {useLocale,useTranslations} from 'next-intl';
import {Button} from '@/components/ui/button';
import {Input} from '@/components/ui/input';
import type {MyTeamApproval,MyTeamEmployee,MyTeamNavigation,MyTeamNormalizedQuery,MyTeamQuery,MyTeamSnapshot,MyTeamTile} from '@/lib/my-team-types';
import {serializeMyTeamQuery,stepMyTeamAnchor,type MyTeamActionResult} from '@/lib/my-team-query';
import {formatDays} from '@/lib/day-format';
import {MyTeamGrid} from './grid';
import {EmployeePanel} from './employee-panel';
import {dateText,instantDateText,STATUS_CLASSES,type MyTeamTranslate} from './presentation';

export type MyTeamProps={snapshot:MyTeamSnapshot;query:MyTeamQuery;navigation:MyTeamNavigation;periodDataHref:string;exportHref:string;approveAction:(data:FormData)=>Promise<MyTeamActionResult>;reviewAction:(data:FormData)=>Promise<MyTeamActionResult>};
const tiles:MyTeamTile[]=['members','checked_in','late','absent','on_leave','pending_approvals'];
const layers=['roster','attendance','leave'] as const;
/** Layers only change presentation; the fetched projection already contains all three sources. */
function dataKey(query:MyTeamQuery){return serializeMyTeamQuery({...query,layers:undefined,companyIds:query.companyIds?.slice().sort()}).toString();}
function actionData(query:MyTeamQuery){const data=new FormData();serializeMyTeamQuery(query).forEach((value,key)=>data.append(key,value));return data;}
function linkWithQuery(href:string,query:MyTeamQuery,format?:string){const params=serializeMyTeamQuery(query);if(format)params.set('format',format);return `${href}?${params}`;}

export function MyTeam(props:MyTeamProps){
 const locale=useLocale();const translate=useTranslations('myTeam');const t:MyTeamTranslate=(key,values)=>translate(key,values);
 const [snapshot,setSnapshot]=useState(props.snapshot);const [navigation,setNavigation]=useState(props.navigation);
 const [query,setQuery]=useState<MyTeamNormalizedQuery>(props.snapshot.query);const [search,setSearch]=useState(props.snapshot.query.search);
 const [loading,setLoading]=useState(false);const [error,setError]=useState<string|null>(null);const [busy,setBusy]=useState(false);const [refresh,setRefresh]=useState(0);
 const [selected,setSelected]=useState<{employmentId:string;date:string}|null>(null);
 const [decision,setDecision]=useState<string|null>(null);const [reason,setReason]=useState('');const [dateIds,setDateIds]=useState<string[]>([]);
 const loadedKey=useRef(dataKey(props.snapshot.query));const epoch=useRef(0);const refreshLoaded=useRef(0);const key=dataKey(query);
 const incomingSnapshot=useRef(props.snapshot);
 useEffect(()=>{
  if(incomingSnapshot.current===props.snapshot)return;incomingSnapshot.current=props.snapshot;epoch.current++;
  loadedKey.current=dataKey(props.snapshot.query);refreshLoaded.current=0;setSnapshot(props.snapshot);setNavigation(props.navigation);setQuery(props.snapshot.query);setSearch(props.snapshot.query.search);setRefresh(0);setLoading(false);setSelected(null);setDecision(null);setError(null);
 },[props.snapshot,props.navigation]);
 const fresh=key===loadedKey.current&&!loading;const employee=selected?snapshot.employees.find(item=>item.employmentId===selected.employmentId):undefined;
 useEffect(()=>{
  if(key===loadedKey.current&&refresh===refreshLoaded.current)return;
  const controller=new AbortController();const request=++epoch.current;setLoading(true);setError(null);setSelected(null);setDecision(null);
  fetch(linkWithQuery(props.periodDataHref,query),{signal:controller.signal,credentials:'same-origin',cache:'no-store'}).then(async response=>{
   if(!response.ok)throw new Error('failed');return response.json() as Promise<{snapshot:MyTeamSnapshot;navigation:MyTeamNavigation}>;
  }).then(result=>{
   if(controller.signal.aborted||request!==epoch.current)return;
   loadedKey.current=key;refreshLoaded.current=refresh;setSnapshot(result.snapshot);setNavigation(result.navigation);
   // Keep local layer switches made while this request was in flight.
   setQuery(current=>({...result.snapshot.query,layers:current.layers}));setLoading(false);
  }).catch(()=>{if(!controller.signal.aborted&&request===epoch.current){setLoading(false);setError(t('error_failed'));}});
  return()=>controller.abort();
  // Layers are local presentation state, and never trigger another period request.
  // eslint-disable-next-line react-hooks/exhaustive-deps
 },[key,refresh,props.periodDataHref]);
 useEffect(()=>{window.history.replaceState(null,'',`${window.location.pathname}?${serializeMyTeamQuery(query)}`);},[query]);
 function update(next:Partial<MyTeamNormalizedQuery>){setSelected(null);setDecision(null);setError(null);setQuery(current=>({...current,...next}));}
 function open(employee:MyTeamEmployee,date:string){setSelected({employmentId:employee.employmentId,date});}
 async function act(action:(data:FormData)=>Promise<MyTeamActionResult>,data:FormData){
  if(busy||!fresh)return;setBusy(true);setError(null);
  try{const result=await action(data);if(result.ok){setDecision(null);setReason('');setDateIds([]);setRefresh(value=>value+1);}else setError(t(`error_${result.error}`));}
  catch{setError(t('error_failed'));}finally{setBusy(false);}
 }
 function approve(approval:MyTeamApproval,reject:boolean){
  if(reject&&!reason.trim()){setError(t('rejectReasonRequired'));return;}
  if(approval.dateDecisionRequired&&!dateIds.length)return;
  const data=actionData(query);data.set('requestId',approval.requestId);data.set('decision',reject?'rejected':'approved');data.set('rejectReason',reject?reason.trim():'');
  if(approval.dateDecisionRequired)dateIds.forEach(id=>data.append('dateIds',id));void act(props.approveAction,data);
 }
 const counts:Record<MyTeamTile,number|null>={members:snapshot.todaySummary.members,checked_in:snapshot.todaySummary.checkedIn,late:snapshot.todaySummary.late,absent:snapshot.todaySummary.absent,on_leave:snapshot.todaySummary.onLeave,pending_approvals:snapshot.todaySummary.pendingApprovals};
 const controlsDisabled=busy;const exportDisabled=!fresh||busy;
 return <div className="space-y-5">
  <header className="flex flex-wrap items-start justify-between gap-3"><div><h1 className="text-xl font-semibold tracking-tight">{t('title')}</h1><p className="mt-1 text-xs leading-5 text-muted-foreground">{t('subtitle')}</p></div><div className="flex flex-wrap gap-2">
  {(['csv','xlsx'] as const).map(format=>exportDisabled?<Button key={format} size="sm" variant="outline" disabled>{t(format==='csv'?'exportCsv':'exportExcel')}</Button>:<Button key={format} asChild size="sm" variant="outline"><a href={linkWithQuery(props.exportHref,query,format)}>{t(format==='csv'?'exportCsv':'exportExcel')}</a></Button>)}
  {fresh&&navigation.roster.href?<Button asChild size="sm" variant="outline"><a href={navigation.roster.href}>{t(navigation.roster.label==='edit'?'editRoster':'viewRoster')}</a></Button>:<Button size="sm" variant="outline" disabled>{t(navigation.roster.label==='edit'?'editRoster':'viewRoster')}</Button>}
  </div></header>
  <div className="flex flex-wrap items-center gap-3 text-xs"><label className="flex items-center gap-2">{t('scope')}<select value={query.scope} disabled={controlsDisabled} onChange={event=>update({scope:event.target.value as MyTeamQuery['scope'],departmentId:undefined,tile:undefined})} className="h-8 rounded-md border border-input bg-background px-2"><option value="direct">{t('direct')}</option><option value="all">{t('all')}</option>{snapshot.scope.canChooseDepartment&&<option value="department">{t('department')}</option>}</select></label>
  {query.scope==='department'&&snapshot.scope.canChooseDepartment&&<label className="flex items-center gap-2">{t('department')}<select value={query.departmentId??''} disabled={controlsDisabled} onChange={event=>update({departmentId:event.target.value||undefined})} className="h-8 max-w-64 rounded-md border border-input bg-background px-2"><option value="">{t('chooseDepartment')}</option>{snapshot.scope.departments.map(department=><option key={department.id} value={department.id}>{department.name}{snapshot.scope.companies.length>1?` · ${snapshot.scope.companies.find(company=>company.id===department.companyId)?.name??''}`:''}</option>)}</select></label>}
  </div>
  {error&&<p role="alert" className="rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-xs text-destructive">{error}</p>}
  <div className="grid items-start gap-5 min-[900px]:grid-cols-2">
  <section aria-label={t('today')} className="grid grid-cols-2 gap-2 min-[900px]:grid-cols-3">{tiles.map(tile=><button key={tile} type="button" disabled={controlsDisabled||!fresh||counts[tile]===null} aria-pressed={query.tile===tile} onClick={()=>update({tile:query.tile===tile?undefined:tile})} className={`rounded-lg border px-3 py-3 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60 ${query.tile===tile?'border-primary bg-primary/5':'border-border bg-background hover:bg-muted/40'}`}><span className="block text-[10px] text-muted-foreground">{t(`tile_${tile}`)}</span><strong className="mt-2 block text-xl tabular-nums">{fresh?counts[tile]??'—':'—'}</strong>{tile==='on_leave'&&fresh&&snapshot.todaySummary.halfDayLeave!==null&&snapshot.todaySummary.halfDayLeave>0&&<span className="mt-1 block text-[10px] text-muted-foreground">{t('halfDayExtra',{count:snapshot.todaySummary.halfDayLeave})}</span>}</button>)}</section>
  {fresh&&<section aria-labelledby="my-team-attention" className="rounded-lg border border-border"><h2 id="my-team-attention" className="flex items-center justify-between gap-2 border-b border-border px-4 py-3 text-xs font-semibold">{t('attention')}<span aria-label={t('attentionCount',{count:snapshot.attention.length})} className="rounded-full bg-muted px-2 py-0.5 text-[10px] tabular-nums">{snapshot.attention.length}</span></h2>{snapshot.attention.length===0?<p className="px-4 py-4 text-xs text-muted-foreground">{t('allClear')}</p>:<ul className="divide-y divide-border">{snapshot.attention.map(item=>{
   const member=snapshot.employees.find(person=>person.employmentId===item.employmentId);if(!member)return null;
   const approval=item.kind==='pending_leave'?item.approval:undefined;
   const roster=item.kind==='absent'?item.roster:undefined;
   const shiftLabel=roster?[roster.code,roster.start&&roster.end?`${roster.start}–${roster.end}`:null].filter(Boolean).join(' · '):'';
   const dot=item.kind==='pending_leave'?'bg-violet-500':item.kind==='absent'?'bg-rose-500':'bg-amber-500';
   return <li key={item.id} className="px-4 py-3 text-xs"><div className="flex flex-wrap items-center justify-between gap-2"><div className="min-w-0 flex-1"><strong className="flex items-start gap-2 font-medium"><span aria-hidden className={`mt-1 size-1.5 shrink-0 rounded-full ${dot}`}/><span>{member.name}{approval?` · ${approval.leaveType} · ${approval.effectiveDates.map(date=>dateText(date.date,locale)).join(' · ')}`:''}</span></strong><p className="mt-1 text-[11px] text-muted-foreground">{approval?`${approval.leaveType} · ${t('pendingLeaveLine',{days:formatDays(approval.days),date:instantDateText(approval.appliedAt,locale),available:formatDays(approval.annualAvailable)})}`:item.kind==='late'?t('lateToday',{name:member.name,minutes:item.lateMinutes??'—'}):item.kind==='absent'?[shiftLabel,t('noCheckIn')].filter(Boolean).join(' · '):t('missingPunch',{name:member.name})}{item.kind==='missing_punch'?` · ${dateText(item.date,locale)}`:''}{(item.kind==='late'||item.kind==='absent')&&item.pendingLeave?` · ${t('leavePending')}`:''}</p></div><div className="flex flex-wrap gap-2">
   <Button size="sm" variant="ghost" onClick={()=>open(member,item.kind==='pending_leave'?snapshot.today:item.date)}>{t('view')}</Button>
   {approval&&<>{!approval.dateDecisionRequired&&<Button size="sm" variant="outline" disabled={busy} onClick={()=>approve(approval,false)}>{busy?t('saving'):t('approve')}</Button>}<Button size="sm" variant="outline" disabled={busy} onClick={()=>{setDecision(decision===item.id?null:item.id);setReason('');setDateIds([]);}}>{t(approval.dateDecisionRequired?'chooseDates':'reject')}</Button></>}
   {item.kind==='missing_punch'&&<Button size="sm" variant="outline" disabled={busy} onClick={()=>{const data=actionData(query);data.set('attendanceId',item.attendanceId);data.set('fingerprint',item.fingerprint);void act(props.reviewAction,data);}}>{busy?t('saving'):t('review')}</Button>}
   </div></div>
   {approval&&decision===item.id&&<div className="mt-3 space-y-3 rounded-md bg-muted/30 p-3">{approval.dateDecisionRequired&&<fieldset><legend className="mb-2 text-[11px] font-medium">{t('chooseDates')}</legend><div className="flex flex-wrap gap-3">{approval.dates.filter(date=>date.status==='pending').map(date=><label key={date.id} className="flex items-center gap-2 text-[11px]"><input type="checkbox" checked={dateIds.includes(date.id)} onChange={event=>setDateIds(current=>event.target.checked?[...current,date.id]:current.filter(id=>id!==date.id))} disabled={busy}/>{dateText(date.date,locale)} · {formatDays(date.days)}</label>)}</div></fieldset>}
   <label className="block text-[11px]">{t('rejectReason')}<textarea value={reason} onChange={event=>setReason(event.target.value)} disabled={busy} maxLength={2000} rows={2} className="mt-1 block w-full rounded-md border border-input bg-background p-2 text-xs"/></label><div className="flex gap-2">{approval.dateDecisionRequired&&<Button size="sm" disabled={busy||!dateIds.length} onClick={()=>approve(approval,false)}>{t('approve')}</Button>}<Button size="sm" variant="destructive" disabled={busy||!reason.trim()||(approval.dateDecisionRequired&&!dateIds.length)} onClick={()=>approve(approval,true)}>{t('reject')}</Button><Button size="sm" variant="ghost" disabled={busy} onClick={()=>setDecision(null)}>{t('cancel')}</Button></div></div>}
   </li>;
  })}</ul>}</section>}
  </div>
  <section className="space-y-3"><div className="flex flex-wrap items-center justify-between gap-3"><div className="flex flex-wrap items-center gap-2"><div className="inline-flex rounded-md border border-input p-0.5">{(['week','month'] as const).map(view=><button key={view} type="button" disabled={controlsDisabled} aria-pressed={query.view===view} onClick={()=>update({view})} className={`rounded px-3 py-1.5 text-xs ${query.view===view?'bg-primary text-primary-foreground':'text-muted-foreground hover:bg-muted'}`}>{t(view)}</button>)}</div><Button size="sm" variant="outline" disabled={controlsDisabled} aria-label={t('previous')} onClick={()=>update({anchorDate:stepMyTeamAnchor(query,-1)})}>‹</Button><span className="text-xs font-medium">{query.view==='month'?dateText(query.anchorDate,locale,{month:'long',year:'numeric'}):fresh?`${dateText(snapshot.period.from,locale,{weekday:'short',day:'numeric',month:'short'})}–${dateText(snapshot.period.to,locale,{weekday:'short',day:'numeric',month:'short',year:'numeric'})}`:t('loading')}</span><Button size="sm" variant="outline" disabled={controlsDisabled} aria-label={t('next')} onClick={()=>update({anchorDate:stepMyTeamAnchor(query,1)})}>›</Button><Button size="sm" variant="ghost" disabled={controlsDisabled} onClick={()=>update({anchorDate:snapshot.today})}>{t('today')}</Button></div><form onSubmit={event=>{event.preventDefault();update({search:search.trim()});}} className="w-full sm:w-64"><Input aria-label={t('search')} placeholder={t('search')} value={search} maxLength={100} disabled={controlsDisabled} onChange={event=>setSearch(event.target.value)}/></form></div>
  <div className="flex flex-wrap items-center justify-between gap-3 text-[10px]"><fieldset className="flex gap-3"><legend className="sr-only">{t('show')}</legend><span aria-hidden className="text-muted-foreground">{t('show')}</span>{layers.map(layer=><label key={layer} className="flex items-center gap-1.5"><input type="checkbox" checked={query.layers[layer]} onChange={event=>update({layers:{...query.layers,[layer]:event.target.checked}})}/>{t(layer)}</label>)}</fieldset><div className="flex flex-wrap gap-2">{(['present','late','absent','approved_leave','off','upcoming'] as const).map(status=><span key={status} className={`rounded-full px-2 py-1 ${STATUS_CLASSES[status]}`}>{t(`status_${status}`)}</span>)}<span className="rounded-full border border-dashed border-violet-400 px-2 py-1 text-violet-700 dark:text-violet-300">{t('status_pending_leave')}</span></div></div>
  {layers.filter(source=>snapshot.availability[source]==='unavailable').map(source=><p key={source} className="text-xs text-muted-foreground">{t('sourceUnavailable',{source:t(source)})}</p>)}
  {!fresh?<p role="status" className="rounded-lg border border-border p-8 text-center text-sm text-muted-foreground">{error?t('error_failed'):t('loading')}</p>:snapshot.gridEmploymentIds.length?<MyTeamGrid snapshot={snapshot} query={query} locale={locale} t={t} onOpen={open}/>:<div className="rounded-lg border border-border p-8 text-center"><p className="text-sm text-muted-foreground">{t('empty')}</p><Button className="mt-3" size="sm" variant="outline" onClick={()=>{setSearch('');update({search:'',tile:undefined});}}>{t('wholeTeam')}</Button></div>}
  </section>
  {fresh&&selected&&employee&&<EmployeePanel key={`${employee.employmentId}:${employee.weeks.find(week=>week.from<=selected.date&&week.to>=selected.date)?.from??selected.date}`} employee={employee} selectedDate={selected.date} snapshot={snapshot} navigation={navigation} locale={locale} t={t} onClose={()=>setSelected(null)}/>}
 </div>;
}
