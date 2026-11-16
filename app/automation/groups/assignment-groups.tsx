'use client';
import {useState,useTransition} from 'react';
import {useRouter} from 'next/navigation';
import {useTranslations} from 'next-intl';
import type {AutomationGroupWorkspace} from '@/packs/automation/service';
import {saveAssignmentGroupsAction,searchAssignmentGroupPeopleAction} from '../actions';
import {PeopleSearch} from '../people-search';

/** One group editor for the existing shared identities; no alternate member store or copied permissions. */
export function AssignmentGroups({initial,usedBy}:{initial:AutomationGroupWorkspace;usedBy:Record<string,string[]>}){
 const t=useTranslations('automation.sharedGroups'),common=useTranslations('automation'),router=useRouter(),[busy,start]=useTransition(),[draft,setDraft]=useState(initial),[saved,setSaved]=useState(initial),[dirty,setDirty]=useState(false),[notice,setNotice]=useState<{error:boolean;text:string}|null>(null);
 const edit=(update:(next:AutomationGroupWorkspace)=>void)=>{setDraft(current=>{const next=structuredClone(current);update(next);return next;});setDirty(true);setNotice(null);};
 const names=draft.groups.map(group=>group.name.trim().toLocaleLowerCase());
 const valid=draft.groups.every(group=>group.name.trim()&&group.limit>=0&&group.limit<=1000&&Number.isInteger(group.limit))&&new Set(names).size===names.length;
 const save=()=>start(async()=>{
  try{const result=await saveAssignmentGroupsAction({revision:saved.revision,v9Revision:saved.v9Revision,groups:draft.groups,reason:t('saveReason')});
  if(!result.ok){setNotice({error:true,text:result.detail??t('failed')});return;}
  setDraft(result.result);setSaved(result.result);setDirty(false);setNotice({error:false,text:t('saved')});router.refresh();
  }catch{setNotice({error:true,text:t('failed')});}
 });
 return <section className="v9-stack" aria-labelledby="shared-group-members-title">
  <div className="automation-row automation-between"><div><h2 id="shared-group-members-title">{common('groups.title')}</h2><p className="v9-muted">{t('intro')}</p></div><button type="button" className="v9-button" disabled={busy||draft.groups.length>=100} onClick={()=>edit(next=>{next.groups.push({id:crypto.randomUUID(),name:t('new'),members:[],limit:20});})}>{t('new')}</button></div>
  {!draft.groups.length&&<p className="v9-notice">{t('empty')}</p>}
  <div className="pcg-grid2">{draft.groups.map(group=><article className="pcg-card v9-stack" key={group.id} aria-label={group.name||t('unnamed')}>
   <div className="v9-fields"><label className="v9-field"><span>{t('name')}</span><input value={group.name} maxLength={200} disabled={busy} onChange={event=>edit(next=>{next.groups.find(item=>item.id===group.id)!.name=event.target.value;})}/></label><label className="v9-field"><span>{t('limit')}</span><input type="number" min={0} max={1000} step={1} value={group.limit} disabled={busy} onChange={event=>edit(next=>{next.groups.find(item=>item.id===group.id)!.limit=Number(event.target.value);})}/></label></div>
   <p className="v9-muted">{usedBy[group.id]?.length?t('usedBy',{list:usedBy[group.id].join('; ')}):t('unused')}</p>
   <ul className="automation-plain-list">{group.members.map(id=><li key={id} className="automation-row automation-between"><span>{draft.people.find(person=>person.id===id)?.name??t('unavailableMember')}</span>{!saved.groups.find(item=>item.id===group.id)?.members.includes(id)&&<button type="button" className="v9-button" disabled={busy} aria-label={t('removeLabel',{person:draft.people.find(person=>person.id===id)?.name??t('unavailableMember'),group:group.name})} onClick={()=>edit(next=>{const target=next.groups.find(item=>item.id===group.id)!;target.members=target.members.filter(member=>member!==id);})}>{t('remove')}</button>}</li>)}</ul>
   {!group.members.length&&<p className="v9-notice v9-warning">{t('noMembers')}</p>}
   <PeopleSearch searchPeople={searchAssignmentGroupPeopleAction} disabled={busy} known={draft.people.filter(person=>group.members.includes(person.id))} onAdd={person=>edit(next=>{if(!next.people.some(item=>item.id===person.id))next.people.push(person);const target=next.groups.find(item=>item.id===group.id)!;if(!target.members.includes(person.id))target.members.push(person.id);})}/>
   {!saved.groups.some(item=>item.id===group.id)&&<button type="button" className="v9-button" disabled={busy} onClick={()=>edit(next=>{next.groups=next.groups.filter(item=>item.id!==group.id);})}>{t('discardNew')}</button>}
  </article>)}</div>
  <p className="v9-muted">{t('behavior')}</p>
  {!valid&&<p className="v9-notice v9-warning" role="alert">{t('invalid')}</p>}
  {notice&&<p role={notice.error?'alert':'status'} className={'v9-notice'+(notice.error?' v9-error':'')}>{notice.text}</p>}
  <div className="automation-row"><button type="button" className="v9-button v9-button-primary" disabled={busy||!dirty||!valid} onClick={save}>{busy?t('saving'):t('save')}</button>{dirty&&<button type="button" className="v9-button" disabled={busy} onClick={()=>{setDraft(saved);setDirty(false);setNotice(null);}}>{t('discard')}</button>}</div>
 </section>;
}
