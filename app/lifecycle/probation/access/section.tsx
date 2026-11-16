import Link from 'next/link';
import {getTranslations} from 'next-intl/server';
import type {SessionContext} from '@/db/client';
import {todayInKualaLumpur} from '@/lib/hr-date';
import {searchProbationAccessPeople,PROBATION_CASE_PERMISSIONS,PROBATION_SETTINGS_PERMISSIONS,type ProbationAccessMember,type ProbationAccessPermission,type ProbationAccessRole,type ProbationAccessView} from '@/packs/probation/service';
import {addMemberAction,changeMemberAction,retireRoleAction,revokeMemberAction,saveRoleAction,saveSuperiorRuleAction} from './actions';
import './access.css';

/** Where the section is shown: its own page (/lifecycle/probation/access) or inside Probation settings (prototype). */
export type AccessHost='access'|'settings';
const HOST_PAGE:Record<AccessHost,string>={access:'/lifecycle/probation/access',settings:'/lifecycle/probation/settings'};
const one=(value:string|string[]|undefined)=>typeof value==='string'?value:undefined;
/** Message keys cannot contain dots, so each stored permission has its own key. */
const PERMISSION_KEY:Record<ProbationAccessPermission,string>={'cases.view':'view','cases.letters':'letters','cases.low_result':'lowResult','cases.route':'route','settings.configure':'configure','settings.intake':'intake','settings.postings':'postings'};
type T=Awaited<ReturnType<typeof getTranslations>>;
type Ctx={t:T;page:string;host:AccessHost};

/**
 * Probation Confirmation › Configuration › Access (handoff B7; prototype AccessSection inside SettingsPage). The page
 * and every command are decided by the database; this only draws what probationAccessView returned. On the settings
 * page it is a card with its own heading (prototype); on its own page the ConfigHead carries the heading.
 */
export async function AccessSection({session,view,query,host}:{session:SessionContext;view:ProbationAccessView;query:Record<string,string|string[]|undefined>;host:AccessHost}){
 const t=await getTranslations('probationAccess'),page=HOST_PAGE[host],c:Ctx={t,page,host};
 const finding=one(query.find),search=(one(query.q)??'').slice(0,100);
 const found=finding&&search.trim().length>=2?await searchProbationAccessPeople(session,search):null;
 const today=todayInKualaLumpur(),newRole=one(query.new)==='1';
 return <section id="access" className="probation-access" aria-labelledby={host==='settings'?'probation-access-title':undefined}>
  <div className="pcg-card">
   {host==='settings'&&<div><h2 id="probation-access-title">{t('title')}</h2><p className="pcg-sub">{t('intro')}</p></div>}
   <SuperiorRule view={view} c={c}/>
  </div>
  <section className="pcg-card" aria-labelledby="probation-access-roles">
   <div className="pcg-row pcg-between"><div><h2 id="probation-access-roles">{t('roles.title')}</h2><p className="pcg-sub">{t('roles.intro')}</p></div>
    {!newRole&&<Link className="v9-button v9-button-primary" href={page+'?new=1#new-role'}>{t('roles.newRole')}</Link>}</div>
   {newRole&&<div className="probation-access-box v9-stack"><RoleEditor role={null} c={c}/></div>}
   {view.roles.map(role=><div key={role.id} className="probation-access-box v9-stack">
    <RoleEditor role={role} c={c}/>
    <Members role={role} view={view} c={c} today={today} finding={finding===role.id} search={search} found={finding===role.id?found:null}/>
   </div>)}
   {!view.roles.length&&!newRole&&<p className="v9-muted">{t('roles.empty')}</p>}
  </section>
  {view.earlier.length>0&&<section className="pcg-card" aria-labelledby="probation-access-earlier">
   <div><h2 id="probation-access-earlier">{t('earlier.title')}</h2><p className="pcg-sub">{t('earlier.intro')}</p></div>
   <ul className="v9-list">{view.earlier.map((row,index)=><li key={index}>
    <strong>{row.name}</strong> · {t(row.role==='pbp'?'earlier.pbp':'earlier.gbs')} · {view.companies.find(co=>co.id===row.companyId)?.name??''} · {t('earlier.validFrom',{date:row.validFrom})}{row.validTo?' · '+t('earlier.validTo',{date:row.validTo}):''}
   </li>)}</ul>
  </section>}
 </section>;
}

const ReturnTo=({c}:{c:Ctx})=><input type="hidden" name="returnTo" value={c.host}/>;

function SuperiorRule({view,c}:{view:ProbationAccessView;c:Ctx}){
 const t=c.t;
 const rule=view.rule;
 return <form action={saveSuperiorRuleAction} className="probation-access-box v9-stack" aria-labelledby="probation-access-superiors">
   <ReturnTo c={c}/><input type="hidden" name="revision" value={rule.revision}/>
   <div className="v9-actions"><h3 id="probation-access-superiors">{t('superiors.title')}</h3><span className={rule.enabled?'pcg-pill pcg-pill-ok':'pcg-pill'}>{rule.enabled?t('on'):t('off')}</span></div>
   <p className="v9-muted">{t('superiors.intro')}</p>
   <div className="probation-access-list">
    <label className="probation-access-check"><input type="checkbox" name="enabled" defaultChecked={rule.enabled}/><span>{t('superiors.enabled')}</span></label>
    <label className="probation-access-check"><input type="checkbox" name="view" defaultChecked={rule.view}/><span>{t('superiors.view')}</span></label>
    <label className="probation-access-check" aria-disabled="true"><input type="checkbox" checked={rule.enabled} disabled readOnly/><span>{t('superiors.kpis')} <span className="v9-muted">{t('superiors.alwaysOn')}</span></span></label>
    <label className="probation-access-check" aria-disabled="true"><input type="checkbox" checked={rule.enabled} disabled readOnly/><span>{t('superiors.assessments')} <span className="v9-muted">{t('superiors.alwaysOn')}</span></span></label>
    <label className="probation-access-check"><input type="checkbox" name="declined" defaultChecked={rule.recordDeclined}/><span>{t('superiors.declined')}</span></label>
   </div>
   {!rule.enabled&&<p className="v9-notice v9-warning" role="status">{t('superiors.offWarning')}</p>}
   <div className="v9-actions"><button className="v9-button v9-button-primary" type="submit">{t('superiors.save')}</button></div>
  </form>;
}

function RoleEditor({role,c}:{role:ProbationAccessRole|null;c:Ctx}){
 const t=c.t;
 const permissions=new Set<string>(role?.permissions??['cases.view']);
 const box=(permission:ProbationAccessPermission)=><label key={permission} className="probation-access-check"><input type="checkbox" name="permission" value={permission} defaultChecked={permissions.has(permission)}/><span>{t('permissions.'+PERMISSION_KEY[permission])}</span></label>;
 return <div className="v9-stack" id={role?undefined:'new-role'}>
  <form action={saveRoleAction} className="v9-stack">
   <ReturnTo c={c}/>{role&&<input type="hidden" name="roleId" value={role.id}/>}
   <input type="hidden" name="revision" value={role?.revision??0}/>
   <label className="v9-field probation-access-name">{t('roles.name')}<input className="v9-input" name="name" required maxLength={120} defaultValue={role?.name??t('roles.newRoleName')}/></label>
   <div className="probation-access-perms">
    <fieldset><legend>{t('roles.cases')}</legend><div className="probation-access-list">{PROBATION_CASE_PERMISSIONS.map(box)}</div><p className="v9-muted">{t('roles.actNote')}</p></fieldset>
    <fieldset><legend>{t('roles.settings')}</legend><div className="probation-access-list">{PROBATION_SETTINGS_PERMISSIONS.map(box)}</div><p className="v9-muted">{t('roles.postingsNote')}</p></fieldset>
   </div>
   <div className="v9-actions"><button className="v9-button v9-button-primary" type="submit">{t('roles.save')}</button>{!role&&<Link className="v9-button" href={c.page}>{t('roles.cancel')}</Link>}</div>
  </form>
  {role&&<form action={retireRoleAction} className="v9-actions">
   <ReturnTo c={c}/><input type="hidden" name="roleId" value={role.id}/><input type="hidden" name="revision" value={role.revision}/><input type="hidden" name="name" value={role.name}/>
   <button className="v9-button v9-button-danger" type="submit" aria-label={t('roles.deleteConfirm',{name:role.name})}>{t('roles.delete')}</button>
  </form>}
 </div>;
}

function memberState(member:ProbationAccessMember,today:string):'active'|'scheduled'|'expired'{
 if(member.validTo&&member.validTo<today)return 'expired';
 return member.validFrom>today?'scheduled':'active';
}

function ScopeFields({view,member,t}:{view:ProbationAccessView;member:Pick<ProbationAccessMember,'businessGroupId'|'companyId'|'validFrom'|'validTo'>;t:T}){
 return <>
  <label className="v9-field">{t('members.businessGroup')}<select name="businessGroupId" defaultValue={member.businessGroupId??''}><option value="">{t('members.allBusinessGroups')}</option>{view.businessGroups.map(group=><option key={group.id} value={group.id}>{group.name}</option>)}</select></label>
  <label className="v9-field">{t('members.company')}<select name="companyId" defaultValue={member.companyId??''}><option value="">{t('members.allCompanies')}</option>
   {view.businessGroups.map(group=><optgroup key={group.id} label={group.name}>{view.companies.filter(company=>company.businessGroupId===group.id).map(company=><option key={company.id} value={company.id}>{company.name}</option>)}</optgroup>)}
  </select></label>
  <label className="v9-field">{t('members.validFrom')}<input type="date" name="validFrom" required defaultValue={member.validFrom}/></label>
  <label className="v9-field">{t('members.validTo')}<input type="date" name="validTo" defaultValue={member.validTo??''}/></label>
 </>;
}

function Members({role,view,c,today,finding,search,found}:{role:ProbationAccessRole;view:ProbationAccessView;c:Ctx;today:string;finding:boolean;search:string;found:{id:string;name:string}[]|null}){
 const t=c.t,PAGE=c.page;
 return <div className="v9-stack">
  <h3>{t('members.title')}</h3>
  {!role.members.length&&<p className="v9-muted">{t('members.empty')}</p>}
  {role.members.map(member=>{const state=memberState(member,today);return <div key={member.id} className="probation-access-member">
   <form action={changeMemberAction} className="probation-access-member-row">
    <ReturnTo c={c}/><input type="hidden" name="memberId" value={member.id}/><input type="hidden" name="personName" value={member.name}/>
    <div><strong>{member.name}</strong><p className={'probation-access-state probation-access-'+state}>{t('members.'+state)}</p></div>
    <ScopeFields view={view} member={member} t={t}/>
    <button className="v9-button" type="submit">{t('members.save')}</button>
   </form>
   <form action={revokeMemberAction}>
    <ReturnTo c={c}/><input type="hidden" name="memberId" value={member.id}/><input type="hidden" name="personName" value={member.name}/><input type="hidden" name="roleName" value={role.name}/>
    <button className="v9-button v9-button-danger" type="submit" aria-label={t('members.removeLabel',{name:member.name,role:role.name})}>{t('members.remove')}</button>
   </form>
  </div>;})}
  {!finding&&<p><Link className="v9-button" href={PAGE+'?find='+role.id+'#role-'+role.id}>{t('members.add')}</Link></p>}
  {finding&&<div className="v9-stack" id={'role-'+role.id}>
   <form method="get" action={PAGE} className="v9-actions">
    <input type="hidden" name="find" value={role.id}/>
    <label className="v9-field">{t('members.find')}<input className="v9-input" name="q" minLength={2} maxLength={100} defaultValue={search} autoFocus/></label>
    <button className="v9-button" type="submit">{t('members.search')}</button>
   </form>
   {found&&!found.length&&<p className="v9-muted">{t('members.noMatch',{query:search})}</p>}
   {found?.map(person=><form key={person.id} action={addMemberAction} className="probation-access-member-row">
    <ReturnTo c={c}/><input type="hidden" name="roleId" value={role.id}/><input type="hidden" name="roleName" value={role.name}/>
    <input type="hidden" name="userId" value={person.id}/><input type="hidden" name="personName" value={person.name}/>
    <div><strong>{person.name}</strong></div>
    <ScopeFields view={view} member={{businessGroupId:null,companyId:null,validFrom:today,validTo:null}} t={t}/>
    <button className="v9-button v9-button-primary" type="submit">{t('members.addPerson',{name:person.name})}</button>
   </form>)}
  </div>}
 </div>;
}
