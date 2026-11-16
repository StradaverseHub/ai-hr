'use client';
import type {ReactNode} from 'react';
import Link from 'next/link';
import {useState,useTransition} from 'react';
import {useRouter} from 'next/navigation';
import {useTranslations} from 'next-intl';
import {MAX_ROUTING_PEOPLE,routingProblems,type Routing,type RoutingDimension,type RoutingRow} from '@/lib/automation/routing';
import {MultiSelect} from '../multi-select';
import {PeopleSearch} from '../people-search';
import type {NamedOption} from '../recipients';
import {saveRoutingAction} from '../actions';
import {LEGACY_BUILDERS,type AutomationPageAccess} from '../types';
import {ConfigHead} from '@/app/lifecycle/probation/settings/config-head';

export type ListedRouting = { routing: Routing; revision: number; retired: boolean; usedBy: string[] };
export type RoutingOptions = { businessGroups: NamedOption[]; companies: (NamedOption & { businessGroupId: string })[]; departments: (NamedOption & { companyId: string })[]; jobTitles: string[] };

/** HR Automation › Assignment groups (prototype GroupsPage; mockup 16): groups stay in On/Off Boarding; routing rules are edited here. */
export function GroupsWorkspace({access,groups,routings,options,people:initialPeople,groupSection}:{groupSection?:ReactNode;access:AutomationPageAccess;groups:NamedOption[];routings:ListedRouting[];options:RoutingOptions;people:NamedOption[]}){
 const t=useTranslations('automation'),[people,setPeople]=useState(initialPeople),[creating,setCreating]=useState<ListedRouting|null>(null);
 const live=routings.filter(r=>!r.retired),retired=routings.filter(r=>r.retired);
 const names=routings.map(r=>r.routing.name.trim().toLowerCase());
 // Prototype GroupsPage (lane M3): a card per assignment group with what uses it, then Routing rules as routing cards.
 // Groups, their members and open task limits stay in the On/Off Boarding configuration (ADR decision 2).
 const usedBy=(groupId:string)=>live.filter(r=>r.routing.rows.some(row=>row.assignTo.kind==='group'&&row.assignTo.groupId===groupId)).map(r=>t('groups.routingNamed',{name:r.routing.name}));
 return <main className="v9-stack pcg">
  <ConfigHead crumb={t('crumb')+' / '+t('groups.title')} title={t('groups.title')} sub={t('groups.intro')} actions={!groupSection&&access.legacy?<Link className="v9-button" href={LEGACY_BUILDERS.groups}>{t('groups.editGroups')}</Link>:undefined}/>
  {groupSection??<section className="v9-stack" aria-labelledby="automation-groups-title">
   <div><h2 id="automation-groups-title" className="sr-only">{t('groups.groups')}</h2><p className="pcg-hint">{t('groups.groupsIntro')}</p>{!access.legacy&&<p className="pcg-hint">{t('groups.groupsReadOnly')}</p>}</div>
   {groups.length===0?<p className="v9-muted">{t('groups.noGroups')}</p>:<ul className="pcg-grid2" style={{listStyle:'none',margin:0,padding:0}}>{groups.map(g=>{const used=usedBy(g.id);return <li key={g.id} className="pcg-card" aria-label={g.name}>
    <div><span className="pcg-hint">{t('groups.groupName')}</span><h3 className="pcg-group-name">{g.name}</h3></div>
    <p className="pcg-hint">{used.length?t('groups.usedByList',{list:used.join('; ')}):t('groups.usedBy',{count:0})}</p>
   </li>;})}</ul>}
  </section>}
  <section className="pcg-card" aria-label={t('groups.routings')}>
   <div className="pcg-row pcg-between" style={{alignItems:'flex-start'}}><div style={{flex:'1 1 480px'}}><h2>{t('groups.routings')}</h2><p className="pcg-sub">{t('groups.routingIntro')} {t('groups.approvalNote')}</p></div>
    <button type="button" className="v9-button v9-button-primary" disabled={!!creating} onClick={()=>setCreating({routing:{id:crypto.randomUUID(),name:'',rows:[{match:{},assignTo:{kind:'group',groupId:groups[0]?.id??''}}]},revision:0,retired:false,usedBy:[]})}>{t('groups.newRouting')}</button></div>
   <p className="v9-muted">A row with no conditions is the explicit default. Offboarding uses it when the selected row has no available recipients. Without an eligible default, the assignment stops for attention.</p>
   <details className="automation-details"><summary>{t('people.title')}</summary><PeopleSearch known={people} onAdd={person=>setPeople(list=>list.some(p=>p.id===person.id)?list:[...list,person])}/></details>
   {creating&&<RoutingEditor key={creating.routing.id} item={creating} groups={groups} options={options} people={people} takenNames={names} onDone={()=>setCreating(null)}/>}
   {live.length===0&&!creating&&<p className="v9-muted">{t('groups.noRoutings')}</p>}
   {live.map(item=><RoutingEditor key={item.routing.id} item={item} groups={groups} options={options} people={people} takenNames={names.filter(n=>n!==item.routing.name.trim().toLowerCase())}/>)}
   {retired.length>0&&<details className="automation-details"><summary>{t('groups.retired',{count:retired.length})}</summary><ul className="automation-plain-list">{retired.map(r=><li key={r.routing.id}>{r.routing.name}</li>)}</ul></details>}
  </section>
 </main>;
}

const DIMENSIONS: RoutingDimension[] = ['businessGroup', 'company', 'department', 'jobTitle'];

function RoutingEditor({item,groups,options,people,takenNames,onDone}:{item:ListedRouting;groups:NamedOption[];options:RoutingOptions;people:NamedOption[];takenNames:string[];onDone?:()=>void}){
 const t=useTranslations('automation'),router=useRouter(),[busy,start]=useTransition();
 const [draft,setDraft]=useState(item.routing),[revision,setRevision]=useState(item.revision),[dirty,setDirty]=useState(item.revision===0),[message,setMessage]=useState<{kind:'error'|'status';text:string;problems?:string[]}|null>(null);
 const change=(edit:(routing:Routing)=>void)=>{setDraft(current=>{const next=structuredClone(current);edit(next);return next;});setDirty(true);setMessage(null);};
 const setRow=(index:number,edit:(row:RoutingRow)=>void)=>change(r=>edit(r.rows[index]));
 const duplicate=!!draft.name.trim()&&takenNames.includes(draft.name.trim().toLowerCase());
 const problems=[...routingProblems(draft,id=>groups.some(g=>g.id===id)),...(duplicate?[t('groups.duplicateName')]:[])];
 const label=(dimension:RoutingDimension,value:string)=>dimension==='businessGroup'?options.businessGroups.find(o=>o.id===value)?.name??value:dimension==='company'?options.companies.find(o=>o.id===value)?.name??value:dimension==='department'?options.departments.find(o=>o.id===value)?.name??value:value;
 const choices=(dimension:RoutingDimension,row:RoutingRow)=>{
  if(dimension==='businessGroup')return options.businessGroups.map(o=>({value:o.id,label:o.name}));
  if(dimension==='company'){const bgs=row.match.businessGroup??[];return options.companies.filter(c=>!bgs.length||bgs.includes(c.businessGroupId)).map(o=>({value:o.id,label:o.name}));}
  if(dimension==='department'){const companies=row.match.company??[];return options.departments.filter(d=>!companies.length||companies.includes(d.companyId)).map(o=>({value:o.id,label:o.name}));}
  return options.jobTitles.map(title=>({value:title,label:title}));
 };
 const describe=(row:RoutingRow)=>{
  const parts=DIMENSIONS.filter(d=>row.match[d]?.length).map(d=>t('groups.dimension.'+d)+': '+row.match[d]!.map(v=>label(d,v)).join(' or '));
  const target=row.assignTo.kind==='group'?(()=>{const id=row.assignTo.kind==='group'?row.assignTo.groupId:'';const g=groups.find(x=>x.id===id);return g?t('groups.toGroup',{name:g.name}):t('groups.noGroupChosen');})()
   :row.assignTo.userIds.length?row.assignTo.userIds.map(id=>people.find(p=>p.id===id)?.name??t('groups.unknownPerson')).join(', '):t('groups.noPeopleChosen');
  return (parts.length?t('groups.matches',{what:parts.join(' · ')}):t('groups.matchesEveryone'))+' · '+t('groups.goesTo',{who:target});
 };
 const save=(retire:boolean)=>{if(!retire&&problems.length){setMessage({kind:'error',text:t('groups.fixFirst'),problems});return;}
  start(async()=>{const result=await saveRoutingAction({routing:draft,retired:retire,expectedRevision:revision,reason:retire?t('groups.reasonRetire'):revision?t('groups.reasonSave'):t('groups.reasonCreate')});
   if(!result.ok){setMessage({kind:'error',text:result.detail??t('errors.unavailable'),problems:result.problems});return;}
   setRevision(result.result.revision);setDirty(false);setMessage({kind:'status',text:retire?t('groups.retiredNow',{name:draft.name}):t('editor.saved')});router.refresh();if(onDone)onDone();});};
 return <article className="pcg-rt-card" aria-label={draft.name||t('groups.newRoutingName')}>
  <div className="automation-row automation-between">
   <label className="v9-field"><span>{t('groups.routingName')}</span><input value={draft.name} maxLength={200} disabled={busy} aria-invalid={!draft.name.trim()||duplicate} onChange={e=>change(r=>{r.name=e.target.value;})}/></label>
   <span className="v9-muted">{item.usedBy.length?t('groups.usedIn',{list:item.usedBy.slice(0,3).join('; '),more:Math.max(0,item.usedBy.length-3)}):t('groups.notUsed')}</span>
  </div>
  <ol className="pcg-rt-rows">{draft.rows.map((row,index)=><li key={index} className="pcg-rt-row">
   <div className="automation-routing-row">
    {DIMENSIONS.map(dimension=><div key={dimension} className="v9-field"><span>{t('groups.dimension.'+dimension)}</span>
     <MultiSelect label={t('groups.rowDimension',{row:index+1,dimension:t('groups.dimension.'+dimension)})} value={row.match[dimension]??[]} options={choices(dimension,row)} emptyLabel={t('groups.any')} disabled={busy}
      onChange={next=>setRow(index,r=>{if(next.length)r.match[dimension]=next;else delete r.match[dimension];})}/></div>)}
   </div>
   <div className="automation-row">
    <label className="v9-field"><span>{t('groups.assignTo')}</span><select value={row.assignTo.kind} disabled={busy} onChange={e=>setRow(index,r=>{r.assignTo=e.target.value==='people'?{kind:'people',userIds:[]}:{kind:'group',groupId:groups[0]?.id??''};})}><option value="group">{t('groups.assignGroup')}</option><option value="people">{t('groups.assignPeople')}</option></select></label>
    {row.assignTo.kind==='group'
     ?<label className="v9-field"><span>{t('groups.group')}</span><select value={row.assignTo.groupId} disabled={busy} onChange={e=>setRow(index,r=>{r.assignTo={kind:'group',groupId:e.target.value};})}>{!groups.some(g=>row.assignTo.kind==='group'&&g.id===row.assignTo.groupId)&&<option value={row.assignTo.groupId}>{t('groups.noGroupChosen')}</option>}{groups.map(g=><option key={g.id} value={g.id}>{g.name}</option>)}</select></label>
     :<div className="v9-field"><span>{t('groups.people',{max:MAX_ROUTING_PEOPLE})}</span><MultiSelect label={t('groups.rowPeople',{row:index+1})} value={row.assignTo.userIds} options={people.map(p=>({value:p.id,label:p.name}))} disabled={busy} onChange={next=>setRow(index,r=>{r.assignTo={kind:'people',userIds:next};})}/></div>}
    <button type="button" className="v9-button" aria-label={t('groups.removeRow',{row:index+1})} disabled={busy} onClick={()=>change(r=>{r.rows.splice(index,1);})}>{t('editor.remove')}</button>
   </div>
   <p className="v9-muted">{describe(row)}</p>
  </li>)}</ol>
  <div className="automation-row"><button type="button" className="v9-button" disabled={busy} onClick={()=>change(r=>{r.rows.push({match:{},assignTo:{kind:'group',groupId:groups[0]?.id??''}});})}>{t('groups.addRow')}</button></div>
  {problems.length>0&&<section className="automation-issues" aria-label={t('editor.problems')}><b>{t('editor.problems')}</b><ul>{problems.map((p,i)=><li key={i}>{p}</li>)}</ul></section>}
  {message&&<div className={message.kind==='error'?'v9-notice v9-error':'v9-notice'} role={message.kind==='error'?'alert':'status'}>{message.text}{message.problems?.length?<ul>{message.problems.map((p,i)=><li key={i}>{p}</li>)}</ul>:null}</div>}
  <div className="automation-row">
   <button type="button" className="v9-button v9-button-primary" disabled={busy||!dirty||problems.length>0} onClick={()=>save(false)}>{t('groups.save')}</button>
   {revision>0&&<button type="button" className="v9-button" disabled={busy} onClick={()=>{if(window.confirm(t('groups.retireConfirm',{count:item.usedBy.length})))save(true);}}>{t('groups.retire')}</button>}
   {revision===0&&onDone&&<button type="button" className="v9-button" disabled={busy} onClick={onDone}>{t('groups.cancel')}</button>}
  </div>
 </article>;
}
