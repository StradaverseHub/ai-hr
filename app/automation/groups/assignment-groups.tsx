'use client';
import {useState,useTransition} from 'react';
import {useRouter} from 'next/navigation';
import type {AutomationGroupWorkspace} from '@/packs/automation/service';
import {saveAssignmentGroupsAction,searchAssignmentGroupPeopleAction} from '../actions';
import {PeopleSearch} from '../people-search';

/** One group editor for the existing shared identities; no alternate member store or copied permissions. */
export function AssignmentGroups({initial,usedBy}:{initial:AutomationGroupWorkspace;usedBy:Record<string,string[]>}){
 const router=useRouter(),[busy,start]=useTransition(),[draft,setDraft]=useState(initial),[saved,setSaved]=useState(initial),[dirty,setDirty]=useState(false),[notice,setNotice]=useState<{error:boolean;text:string}|null>(null);
 const edit=(update:(next:AutomationGroupWorkspace)=>void)=>{setDraft(current=>{const next=structuredClone(current);update(next);return next;});setDirty(true);setNotice(null);};
 const names=draft.groups.map(group=>group.name.trim().toLocaleLowerCase());
 const valid=draft.groups.every(group=>group.name.trim()&&group.limit>=0&&group.limit<=1000&&Number.isInteger(group.limit))&&new Set(names).size===names.length;
 const save=()=>start(async()=>{
  const result=await saveAssignmentGroupsAction({revision:saved.revision,v9Revision:saved.v9Revision,groups:draft.groups,reason:'Updated shared assignment groups from HR Automation'});
  if(!result.ok){setNotice({error:true,text:result.detail??'Groups could not be saved. Your changes are kept here; try again.'});return;}
  setDraft(result.result);setSaved(result.result);setDirty(false);setNotice({error:false,text:'Assignment groups saved.'});router.refresh();
 });
 return <section className="v9-stack" aria-labelledby="shared-group-members-title">
  <div className="automation-row automation-between"><div><h2 id="shared-group-members-title">Assignment groups</h2><p className="v9-muted">Members are shared across HR Automation. Updating a group does not grant access to its cases.</p></div><button type="button" className="v9-button" disabled={busy||draft.groups.length>=500} onClick={()=>edit(next=>{next.groups.push({id:crypto.randomUUID(),name:'New group',members:[],limit:20});})}>New group</button></div>
  {!draft.groups.length&&<p className="v9-notice">Create a group, add the people who can receive work, then select it in a workflow or routing.</p>}
  <div className="pcg-grid2">{draft.groups.map(group=><article className="pcg-card v9-stack" key={group.id} aria-label={group.name||'Unnamed group'}>
   <div className="v9-fields"><label className="v9-field"><span>Group name</span><input value={group.name} maxLength={200} disabled={busy} onChange={event=>edit(next=>{next.groups.find(item=>item.id===group.id)!.name=event.target.value;})}/></label><label className="v9-field"><span>Open task limit</span><input type="number" min={0} max={1000} step={1} value={group.limit} disabled={busy} onChange={event=>edit(next=>{next.groups.find(item=>item.id===group.id)!.limit=Number(event.target.value);})}/></label></div>
   <p className="v9-muted">{usedBy[group.id]?.length?'Used by: '+usedBy[group.id].join('; '):'No references in the visible shared definitions.'}</p>
   <ul className="automation-plain-list">{group.members.map(id=><li key={id} className="automation-row automation-between"><span>{draft.people.find(person=>person.id===id)?.name??'Unavailable member'}</span><button type="button" className="v9-button" disabled={busy} aria-label={'Remove '+(draft.people.find(person=>person.id===id)?.name??'member')+' from '+group.name} onClick={()=>edit(next=>{const target=next.groups.find(item=>item.id===group.id)!;target.members=target.members.filter(member=>member!==id);})}>Remove</button></li>)}</ul>
   {!group.members.length&&<p className="v9-notice v9-warning">No members. Work that needs this group will need attention.</p>}
   <PeopleSearch searchPeople={searchAssignmentGroupPeopleAction} disabled={busy} known={draft.people.filter(person=>group.members.includes(person.id))} onAdd={person=>edit(next=>{if(!next.people.some(item=>item.id===person.id))next.people.push(person);const target=next.groups.find(item=>item.id===group.id)!;if(!target.members.includes(person.id))target.members.push(person.id);})}/>
   {!saved.groups.some(item=>item.id===group.id)&&<button type="button" className="v9-button" disabled={busy} onClick={()=>edit(next=>{next.groups=next.groups.filter(item=>item.id!==group.id);})}>Discard new group</button>}
  </article>)}</div>
  <p className="v9-muted">Open task limits keep their existing Onboarding and Offboarding behavior. Contract approvals use the selected assignment method. To replace or delete an existing group, use the existing group replacement flow after checking its references.</p>
  {!valid&&<p className="v9-notice v9-warning" role="alert">Use a different name for each group and a whole task limit between 0 and 1,000.</p>}
  {notice&&<p role={notice.error?'alert':'status'} className={'v9-notice'+(notice.error?' v9-error':'')}>{notice.text}</p>}
  <div className="automation-row"><button type="button" className="v9-button v9-button-primary" disabled={busy||!dirty||!valid} onClick={save}>{busy?'Saving…':'Save assignment groups'}</button>{dirty&&<button type="button" className="v9-button" disabled={busy} onClick={()=>{setDraft(saved);setDirty(false);setNotice(null);}}>Discard changes</button>}</div>
 </section>;
}
