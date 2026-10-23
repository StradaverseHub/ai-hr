'use client';
import {useRef,useState} from 'react';
import {useRouter} from 'next/navigation';
import {useTranslations} from 'next-intl';
import {Button,Card,Field,inputCls} from '@/components/ui';
import type {AccessCapability,AccessSnapshot,AccessResolution} from '@/lib/access-permission-model';
import type {AccessConfigurationCommand} from '@/lib/access-configuration-command';
import type {AccessConfigurationPreview} from '@/core/access-configuration';
import type {AccessEditorFailure,AccessEditorResult} from '@/lib/access-editor-result';
export type {AccessEditorFailure,AccessEditorResult} from '@/lib/access-editor-result';

export type AccessEditorCapability=Pick<AccessCapability,'id'|'scope'|'supported'>&{label:string};
type Choice={id:string;label:string};
export type AccessEditorProps={
 actorUserId:string;scopeFingerprint:string;
 snapshot:AccessSnapshot;capabilities:readonly AccessEditorCapability[];users:readonly Choice[];companies:readonly Choice[];
 previewAction:(p:{expectedRevision:string;command:AccessConfigurationCommand})=>Promise<AccessEditorResult<AccessConfigurationPreview>>;
 saveAction:(p:{expectedRevision:string;command:AccessConfigurationCommand;previewFingerprint:string})=>Promise<AccessEditorResult<{revision:string}>>;
 history:readonly {id:string;when:string;actorLabel:string;operationLabel:string}[];
};

/** Server-only data owner and actions authorize every read/write; this component supplies no authority. */
export function AccessConfigurationEditor(props:AccessEditorProps){
 return <AccessConfigurationEditorDraft key={props.snapshot.tenantId+':'+props.snapshot.revision+':'+props.actorUserId+':'+props.scopeFingerprint} {...props}/>;
}
function AccessConfigurationEditorDraft({snapshot,capabilities,users,companies,previewAction,saveAction,history}:AccessEditorProps){
 const t=useTranslations('accessConfiguration'),router=useRouter();
 const groups=snapshot.groups.filter(group=>!group.retired);
 const [groupId,setGroupId]=useState(groups[0]?.id??''),[userId,setUserId]=useState(users[0]?.id??'');
 const group=groups.find(row=>row.id===groupId);
 const [groupName,setGroupName]=useState(group?.name??''),[newName,setNewName]=useState(''),[query,setQuery]=useState('');
 const [scope,setScope]=useState<string|null>(null),[grants,setGrants]=useState(group?.grants.map(row=>({...row}))??[]);
 const [preview,setPreview]=useState<{command:AccessConfigurationCommand;result:AccessConfigurationPreview}|null>(null);
 const [pending,setPending]=useState<'preview'|'save'|null>(null),[error,setError]=useState<AccessEditorFailure|null>(null),[saved,setSaved]=useState(false);
 const [draftOverride,setDraftOverride]=useState<Extract<AccessConfigurationCommand,{kind:'setOverride'}>|null>(null);
 const generation=useRef(0),saving=useRef(false);
 const disabled=pending==='save'||saved;
 const invalidate=()=>{generation.current+=1;setPreview(null);setError(null);setDraftOverride(null);};
 const selectGroup=(id:string)=>{invalidate();setGroupId(id);const next=groups.find(row=>row.id===id);setGroupName(next?.name??'');setGrants(next?.grants.map(row=>({...row}))??[]);};
 const userLabel=(id:string)=>users.find(user=>user.id===id)?.label??t('unavailable');
 const companyLabel=(id:string|null)=>id===null?t('allCompanies'):companies.find(company=>company.id===id)?.label??t('unavailable');
 const capabilityLabel=(id:string)=>capabilities.find(capability=>capability.id===id)?.label??t('unavailable');
 const foundUsers=users.filter(user=>user.id===userId||user.label.toLocaleLowerCase().includes(query.toLocaleLowerCase()));
 const mutableCapabilities=capabilities.filter(capability=>capability.id!=='access.system_admin');
 const matchingMembers=snapshot.memberships.filter(row=>row.groupId===groupId&&row.userId===userId&&row.companyId===scope);
 const derivedMember=matchingMembers.some(row=>row.derived);
 const scopePicker=<Field label={t('companyScope')}><select className={inputCls} value={scope??''} disabled={disabled} onChange={event=>{invalidate();setScope(event.target.value||null);}}><option value="">{t('allCompanies')}</option>{companies.map(company=><option key={company.id} value={company.id}>{company.label}</option>)}</select></Field>;

 async function review(command:AccessConfigurationCommand){
  if(saving.current)return;
  const current=++generation.current;setPreview(null);setError(null);setPending('preview');
  if(command.kind!=='replaceGroupGrants')setGrants(group?.grants.map(row=>({...row}))??[]);
  if(command.kind!=='renameGroup')setGroupName(group?.name??'');
  if(command.kind!=='createGroup')setNewName('');
  setDraftOverride(command.kind==='setOverride'?command:null);
  try{
   const result=await previewAction({expectedRevision:snapshot.revision,command});
   if(generation.current!==current)return;
   if(result.ok)setPreview({command,result:result.value});else setError(result.code);
  }catch{if(generation.current===current)setError('system');}
  finally{if(generation.current===current)setPending(null);else setPending(value=>value==='preview'?null:value);}
 }
 async function confirm(){
  if(!preview||saving.current)return;
  saving.current=true;setPending('save');setError(null);
  try{
   const result=await saveAction({expectedRevision:snapshot.revision,command:preview.command,previewFingerprint:preview.result.fingerprint});
   if(result.ok){setSaved(true);setPreview(null);router.refresh();}else{setPreview(null);setError(result.code);}
  }catch{setPreview(null);setError('system');}
  finally{saving.current=false;setPending(null);}
 }
 function permissionSources(resolution:AccessResolution){
  return <ul className="mt-1 space-y-1 text-xs text-muted-foreground">{resolution.sources.map((source,index)=><li key={source.kind+source.id+index}>{source.kind==='individual'?t('individual'):snapshot.groups.find(row=>row.id===source.id)?.name??t('unavailable')}{' · '}{companyLabel(source.companyId)}{source.kind==='group'&&<span>{' · '}{t('membershipScope')}: {companyLabel(source.membershipCompanyId??null)}</span>}{source.membershipDerived&&<span>{' · '}{t('fromRoles')}</span>}{source.effect==='deny'&&<span>{' · '}{t('deny')}</span>}</li>)}</ul>;
 }
 function commandSubject(command:AccessConfigurationCommand){
  if(command.kind==='createGroup'||command.kind==='renameGroup')return command.name;
  if(command.kind==='setOverride')return userLabel(command.userId);
  const id=command.groupId;return snapshot.groups.find(row=>row.id===id)?.name??t('unavailable');
 }
 function resolutionLabel(resolution:AccessResolution){return resolution.reason==='allowed'?t('allowed'):resolution.reason==='denied'?t('denied'):resolution.reason==='unassigned'?t('noGrant'):t('unavailable');}

 return <div className="space-y-6">
  <div><h2 className="text-xl font-semibold">{t('title')}</h2><p className="mt-1 text-sm text-muted-foreground">{t('description')}</p></div>
  {error&&<div role="alert" className="rounded-md border border-destructive/40 p-3 text-sm text-destructive">{t(`errors.${error}`)}{error==='changed'&&<Button variant="outline" className="ml-3" onClick={()=>router.refresh()}>{t('reload')}</Button>}</div>}
  {saved&&<div role="status" className="rounded-md border p-3 text-sm">{t('saved')} <Button variant="outline" onClick={()=>router.refresh()}>{t('reload')}</Button></div>}
  <fieldset disabled={disabled} className="space-y-6">
   <Card className="space-y-5 p-4 sm:p-6">
    <h3 className="font-semibold">{t('groups')}</h3>
    <div className="grid gap-5 lg:grid-cols-[15rem_minmax(0,1fr)]">
     <nav aria-label={t('groups')} className="space-y-1">{groups.map(row=><button type="button" key={row.id} aria-pressed={groupId===row.id} onClick={()=>selectGroup(row.id)} className={`w-full rounded-md border px-3 py-2 text-left text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${groupId===row.id?'border-primary bg-primary/5':'border-transparent hover:bg-muted'}`}>{row.name}{row.systemAdministrator&&<span className="mt-1 block text-xs text-muted-foreground">{t('protected')}</span>}</button>)}{!groups.length&&<p className="text-sm text-muted-foreground">{t('noGroups')}</p>}</nav>
     <div className="min-w-0 space-y-4">{group&&<>
      <div className="grid gap-4 sm:grid-cols-2"><Field label={t('groupName')}><input className={inputCls} value={groupName} maxLength={100} disabled={group.systemAdministrator||disabled} onChange={event=>{invalidate();setGroupName(event.target.value);}}/></Field>{scopePicker}</div>
      <div className="flex flex-wrap gap-2"><Button type="button" variant="outline" disabled={pending!==null||group.systemAdministrator||!groupName.trim()||groupName===group.name} onClick={()=>review({kind:'renameGroup',groupId:group.id,name:groupName.trim()})}>{t('reviewName')}</Button><Button type="button" variant="outline" disabled={pending!==null||group.systemAdministrator} onClick={()=>review({kind:'retireGroup',groupId:group.id})}>{t('reviewRetirement')}</Button></div>
      {group.systemAdministrator&&<p className="text-sm text-muted-foreground">{t('protectedHelp')}</p>}
      <fieldset className="space-y-2"><legend className="mb-2 text-sm font-medium">{t('permissions')}</legend>{mutableCapabilities.map(capability=>{
       const companyId=capability.scope==='tenant'?null:scope;
       const checked=grants.some(grant=>grant.capabilityId===capability.id&&grant.companyId===companyId);
       return <label key={capability.id} className="flex items-start gap-3 rounded-md border p-3 text-sm"><input type="checkbox" className="mt-0.5 size-4" checked={checked} disabled={!capability.supported||group.systemAdministrator||disabled} onChange={event=>{invalidate();setGrants(rows=>[...rows.filter(row=>row.capabilityId!==capability.id||row.companyId!==companyId),...(event.target.checked?[{capabilityId:capability.id,companyId}]:[])]);}}/><span>{capability.label}<span className="mt-1 block text-xs text-muted-foreground">{!capability.supported?t('notSupported'):capability.scope==='tenant'?t('tenantScope'):companyLabel(companyId)}</span></span></label>;
      })}</fieldset>
      <Button type="button" disabled={pending!==null||group.systemAdministrator||JSON.stringify(grants)===JSON.stringify(group.grants)} onClick={()=>review({kind:'replaceGroupGrants',groupId:group.id,grants})}>{t('previewPermissions')}</Button>
     </>}
     <div className="border-t pt-4"><div className="flex flex-wrap items-end gap-3"><Field label={t('newGroup')} className="min-w-48 flex-1"><input className={inputCls} value={newName} maxLength={100} onChange={event=>{invalidate();setNewName(event.target.value);}}/></Field><Button type="button" variant="outline" disabled={pending!==null||!newName.trim()} onClick={()=>review({kind:'createGroup',groupId:crypto.randomUUID(),name:newName.trim()})}>{t('previewNewGroup')}</Button></div></div>
     </div>
    </div>
   </Card>
   <Card className="space-y-4 p-4 sm:p-6">
    <h3 className="font-semibold">{t('individualAccess')}</h3><p className="text-sm text-muted-foreground">{t('individualHelp')}</p>
    <div className="grid gap-4 sm:grid-cols-2"><Field label={t('searchUsers')}><input type="search" className={inputCls} value={query} onChange={event=>{invalidate();setQuery(event.target.value);}}/></Field><Field label={t('user')}><select className={inputCls} value={userId} onChange={event=>{invalidate();setUserId(event.target.value);}}>{foundUsers.map(user=><option key={user.id} value={user.id}>{user.label}</option>)}</select></Field></div>
    <p className="text-sm">{t('selectedGroup')}: <strong>{group?.name??t('unavailable')}</strong>{' · '}{companyLabel(scope)}</p>
    {derivedMember?<p className="text-sm text-muted-foreground">{t('roleMembershipHelp')}</p>:<Button type="button" variant="outline" disabled={pending!==null||!group||!userId||group.systemAdministrator} onClick={()=>group&&review({kind:'setMembership',groupId:group.id,userId,companyId:scope,enabled:matchingMembers.length===0})}>{matchingMembers.length?t('previewRemoveMember'):t('previewAddMember')}</Button>}
    <div className="space-y-3">{mutableCapabilities.map(capability=>{
     const companyId=capability.scope==='tenant'?null:scope;
     const override=snapshot.overrides.find(row=>row.userId===userId&&row.capabilityId===capability.id&&row.companyId===companyId);
     return <div key={capability.id} className="grid gap-2 rounded-md border p-3 sm:grid-cols-[minmax(0,1fr)_13rem]"><div className="text-sm font-medium">{capability.label}<p className="mt-1 text-xs font-normal text-muted-foreground">{capability.scope==='tenant'?t('tenantScope'):companyLabel(companyId)}</p></div><Field label={t('individualOverride')}><select className={inputCls} value={draftOverride?.userId===userId&&draftOverride.capabilityId===capability.id&&draftOverride.companyId===companyId?draftOverride.effect??'inherit':override?.effect??'inherit'} disabled={!capability.supported||!userId||pending!==null} onChange={event=>{invalidate();void review({kind:'setOverride',userId,capabilityId:capability.id,companyId,effect:event.target.value==='inherit'?null:event.target.value==='allow'?'allow':'deny'});}}><option value="inherit">{t('inherit')}</option><option value="allow">{t('allow')}</option><option value="deny">{t('deny')}</option></select></Field></div>;
    })}</div>
   </Card>
  </fieldset>
  <div aria-live="polite">{pending==='preview'&&<p role="status" className="text-sm text-muted-foreground">{t('preparing')}</p>}</div>
  {preview&&<Card className="space-y-4 p-4 sm:p-6">
   <h3 className="font-semibold">{t('reviewTitle')}</h3><p className="text-sm font-medium">{t(`operations.${preview.command.kind}`)}{`: ${commandSubject(preview.command)}`}</p><p className="text-sm text-muted-foreground">{t('safeguards')}</p>
   {preview.result.changesUnrestrictedScope&&<p className="rounded-md border border-amber-400/50 bg-amber-50/10 p-3 text-sm">{t('futureScope')}</p>}
   {!preview.result.changes.length&&<p className="text-sm text-muted-foreground">{t('noCurrentChanges')}</p>}
   <div className="space-y-3">{preview.result.changes.map((change,index)=><section key={change.userId+change.capabilityId+String(change.companyId)+index} className="rounded-md border p-3"><h4 className="text-sm font-medium">{userLabel(change.userId)} · {capabilityLabel(change.capabilityId)} · {companyLabel(change.companyId)}</h4><div className="mt-2 grid gap-3 sm:grid-cols-2"><div className="text-sm"><p>{t('before')}: {resolutionLabel(change.before)}</p>{permissionSources(change.before)}</div><div className="text-sm"><p>{t('after')}: {resolutionLabel(change.after)}</p>{permissionSources(change.after)}</div></div></section>)}</div>
   <div className="flex flex-wrap gap-3"><Button type="button" disabled={pending!==null||saved} onClick={confirm}>{pending==='save'?t('saving'):t('confirm')}</Button><Button type="button" variant="outline" disabled={pending==='save'} onClick={invalidate}>{t('back')}</Button></div>
  </Card>}
  <Card className="space-y-3 p-4 sm:p-6"><h3 className="font-semibold">{t('history')}</h3>{history.length?<ul className="divide-y">{history.map(event=><li key={event.id} className="py-3 text-sm"><p>{event.operationLabel}</p><p className="mt-1 text-xs text-muted-foreground">{event.actorLabel} · {event.when}</p></li>)}</ul>:<p className="text-sm text-muted-foreground">{t('noHistory')}</p>}</Card>
 </div>;
}
