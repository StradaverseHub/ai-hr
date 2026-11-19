'use client';
import {useTranslations} from 'next-intl';
import {lifecycleTemplateListMetadata} from '@/lib/lifecycle-template-list';
import type {AutomationWorkflow} from '@/lib/automation/workflow';
import {PeopleSearch} from './people-search';
import {useState} from 'react';
import {useRouter} from 'next/navigation';
import type {v9Configuration} from '@/packs/lifecycle/service';
import type {Module} from '@/lib/lifecycle-v9-model';
import {TemplateEditor,ActorContext,RuleLabels} from '@/app/lifecycle/v9/workspace';
import {useV9Configuration} from '@/app/lifecycle/v9/use-v9-configuration';
import {WorkflowEditor as NativeWorkflowEditor} from '@/app/lifecycle/v9/workflow-editor';
import {readV9WorkflowRemoval,removeV9Workflow,restoreV9Workflow} from '@/app/lifecycle/v9/actions';
import {saveV9Config} from '@/app/lifecycle/v9/actions';
import type {RoutingChoices} from '@/app/lifecycle/probation/templates/routing-editor';
export type LifecycleConfigurationData=Awaited<ReturnType<typeof v9Configuration>>;

/** Existing V9 document and rich email editors, hosted in the shared Configuration destination. */
export function LifecycleTemplateSection({initial,filter,choices,sharedWorkflows=[],summaryRoutings=choices.routings}:{initial:LifecycleConfigurationData;filter:Module|'all';choices:RoutingChoices;sharedWorkflows?:AutomationWorkflow[];summaryRoutings?:readonly {id:string;name:string;retired?:boolean}[]}){
 const t=useTranslations('automation');
 const router=useRouter(),configuration=useV9Configuration(initial.config,saveV9Config,()=>router.refresh());
 const[selected,select]=useState(''),[module,setModule]=useState<Module>(filter==='off'?'off':'onb'),[users,setUsers]=useState(initial.users),[uploading,setUploading]=useState(false);
 if(!configuration.draft)return <p className="v9-notice">Set up Onboarding &amp; Offboarding before creating its templates.</p>;
 const label=(key:string,values?:Record<string,string|number>)=>t(key,values);
 const sharedMetadata=lifecycleTemplateListMetadata(configuration.draft,sharedWorkflows,{...choices,routings:summaryRoutings,people:users},label);
 const nativeChoices=initial.nativeDocumentRoutingChoices;
 const nativeMetadata=lifecycleTemplateListMetadata({...configuration.draft,templates:configuration.draft.templates.filter(template=>template.module==='onb'),emails:configuration.draft.emails.filter(email=>email.module==='onb')},[],nativeChoices??{routings:[],groups:[],people:[]},label);
 const listMetadata={documents:{...sharedMetadata.documents,...nativeMetadata.documents},emails:{...sharedMetadata.emails,...nativeMetadata.emails}};
 return <ActorContext.Provider value={initial.actor}><RuleLabels.Provider value={initial.labels}>
  <SaveState configuration={configuration}/><details><summary>Find named people for templates</summary><PeopleSearch known={users} disabled={!initial.editable} onAdd={user=>setUsers(current=>current.some(person=>person.id===user.id)?current:[...current,user])}/></details>
  <TemplateEditor listMetadata={listMetadata} saveState={configuration.state} saveError={configuration.error} retrySave={configuration.retry} uploading={uploading} onUploadingChange={setUploading} nativeRoutingChoices={nativeChoices} key={filter} previewCases={initial.previewCases} users={users} config={configuration.draft} selected={selected} select={select} module={module} setModule={setModule} edit={configuration.edit} editable={initial.editable} saved={configuration.state==='saved'&&!uploading} usage={initial.usage} references={initial.references} routingChoices={{...choices,people:users}} initialFilter={filter} showModuleFilter={false}/>
 </RuleLabels.Provider></ActorContext.Provider>;
}
function SaveState({configuration}:{configuration:ReturnType<typeof useV9Configuration>}){
 return <div className="v9-stack"><p className="v9-muted" role="status">{configuration.state==='saving'||configuration.state==='pending'?'Saving…':configuration.state==='error'?'Changes not saved':'Changes save automatically'}</p>{configuration.error&&<div className="v9-notice v9-error" role="alert">{configuration.error} <button type="button" className="v9-button" onClick={configuration.retry}>Try saving again</button></div>}</div>;
}

/** Members and limits retain their native group IDs and use the existing canonical group writer. */
export function LifecycleGroupSection({initial,usedBy}:{initial:LifecycleConfigurationData;usedBy:Record<string,string[]>}){
 const router=useRouter(),configuration=useV9Configuration(initial.config,saveV9Config,()=>router.refresh()),[people,setPeople]=useState(initial.users);
 const config=configuration.draft;
 if(!config)return <p className="v9-notice">Set up Onboarding &amp; Offboarding before creating assignment groups.</p>;
 const disabled=!initial.editable;
 return <section className="v9-stack" aria-label="Assignment group members"><SaveState configuration={configuration}/><div className="automation-row automation-between"><p className="v9-muted">Groups are shared across HR Automation. Open task limits retain their existing native Onboarding and Offboarding behavior. Contract uses the least recently assigned eligible member; it does not apply leave or open-task limits.</p><button type="button" className="v9-button" disabled={disabled} onClick={()=>configuration.edit(next=>{next.groups.push({id:crypto.randomUUID(),name:'New group',members:[],limit:20});})}>New group</button></div><div className="pcg-grid2">{config.groups.map(group=>{
 const usage=usedBy[group.id]??[];
 return <article className="pcg-card v9-stack" key={group.id} aria-label={group.name}>
  <div className="v9-fields"><label className="v9-field"><span>Group name</span><input value={group.name} maxLength={200} disabled={disabled} onChange={e=>configuration.edit(next=>{next.groups.find(g=>g.id===group.id)!.name=e.target.value;})}/></label><label className="v9-field"><span>Open task limit</span><input type="number" min={0} max={1000} step={1} value={group.limit} disabled={disabled} onChange={e=>configuration.edit(next=>{next.groups.find(g=>g.id===group.id)!.limit=Number(e.target.value);})}/></label></div>
  <p className="v9-muted">{usage.length?'Used by: '+usage.join('; '):'Not used in the visible shared configuration.'}</p>
  <ul className="automation-plain-list">{group.members.map(id=><li key={id}>{people.find(user=>user.id===id)?.name??'Unavailable member'}</li>)}</ul>
  {!group.members.length&&<p className="v9-notice v9-warning">No members. New assignments to this group will need attention.</p>}
  <PeopleSearch known={people.filter(user=>group.members.includes(user.id))} disabled={disabled} onAdd={user=>{setPeople(current=>current.some(person=>person.id===user.id)?current:[...current,user]);configuration.edit(next=>{const target=next.groups.find(g=>g.id===group.id)!;if(!target.members.includes(user.id))target.members.push(user.id);});}}/>
  <p className="v9-muted">Existing memberships are retained here. Group deletion and member removal are not part of this shared builder.</p>
 </article>;
 })}</div></section>;
}

/** Onboarding keeps its native schema, owner actions and runtime inside the shared destination. */
export function LifecycleWorkflowSection({initial,filter='onb',initialSelected=''}:{initial:LifecycleConfigurationData;filter?:Module|'all';initialSelected?:string}){
 const router=useRouter(),configuration=useV9Configuration(initial.config,saveV9Config,()=>router.refresh()),[selected,select]=useState(initialSelected),[module,setModule]=useState<Module>(filter==='off'?'off':'onb'),[notice,setNotice]=useState(''),[users,setUsers]=useState(initial.users),[uploading,setUploading]=useState(false);
 if(!configuration.draft)return <p className="v9-notice">Set up Onboarding before creating workflows.</p>;
 return <section className="v9-stack" aria-label="Lifecycle case workflows"><h2>{filter==='onb'?'Onboarding':filter==='off'?'Other Offboarding case workflows':'Onboarding & other Offboarding workflows'}</h2><p className="v9-muted">These workflows serve Onboarding, manually created Offboarding cases and earlier cases. Managed resignations use the shared Offboarding workflows below; their clearance tasks remain on the case.</p><SaveState configuration={configuration}/>{notice&&<p className="v9-notice" role="status">{notice}</p>}<details><summary>Find named people for workflows</summary><PeopleSearch known={users} disabled={!initial.editable} onAdd={user=>setUsers(current=>current.some(person=>person.id===user.id)?current:[...current,user])}/></details><NativeWorkflowEditor config={configuration.draft} selected={selected} select={select} module={module} setModule={setModule} edit={configuration.edit} editable={initial.editable} users={users} actor={initial.actor} labels={initial.labels} cases={[]} initialFilter={filter} showModuleFilter={false} allowedModules={filter==='all'?['onb','off']:[filter]} historyAvailable={false} previewCases={initial.previewCases} removal={{saved:configuration.state==='saved',preview:readV9WorkflowRemoval,remove:removeV9Workflow,restore:restoreV9Workflow,changed:message=>{setNotice(message);router.refresh();}}}/></section>;
}
