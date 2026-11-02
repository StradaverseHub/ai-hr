import {pageWideCls} from '@/components/ui';
import {getLocale,getTranslations} from 'next-intl/server';
import {requireAccessConfiguration} from '@/lib/access-configuration-authz';
import {AccessConfigurationEditor} from '../access-editor';
import {previewAccessConfigurationAction,saveAccessConfigurationAction} from './actions';
import {actionCapabilityLabelKey} from '@/lib/access-action-presentation';
import {SecurityBackLink} from '../security-page';
const capabilityKeys:Record<string,string>={'access.system_admin':'systemAdministrator','access.configure':'configure','workforce.view':'workforceView','workforce.add':'workforceAdd','workforce.edit':'workforceEdit','workforce.delete':'workforceDelete','workforce.maintain':'workforceMaintain','profile.review':'profileReview','organisation.view':'organisationView','organisation.add':'organisationAdd','organisation.edit':'organisationEdit','organisation.delete':'organisationDelete','settings.view':'settingsView','settings.add':'settingsAdd','settings.edit':'settingsEdit','settings.delete':'settingsDelete'};
export default async function AccessConfigurationPage(){
 const {session,data}=await requireAccessConfiguration(),t=await getTranslations('accessConfiguration'),all=await getTranslations(),locale=await getLocale();
 const users=data.users.map(user=>({...user,label:data.snapshot.users.find(row=>row.id===user.id)?.active?user.label:`${user.label} · ${t('inactive')}`}));
 return <div className={`${pageWideCls} space-y-6`}><SecurityBackLink/><AccessConfigurationEditor actorUserId={session.userId!}
  snapshot={data.snapshot} scopeFingerprint={data.scopeFingerprint} users={users} companies={data.companies}
  capabilities={data.capabilities.map(cap=>{const key=capabilityKeys[cap.id]??actionCapabilityLabelKey(cap.id);const operation=cap.id.slice(cap.id.lastIndexOf('.')+1),operationKey='matrix'+operation[0].toUpperCase()+operation.slice(1);return {...cap,label:cap.presentation&&all.has(cap.presentation.labelKey)&&t.has(operationKey)?`${all(cap.presentation.labelKey)} · ${t(operationKey)}`:key?t(`capabilities.${key}`):t('unavailable')};})}
  previewAction={previewAccessConfigurationAction} saveAction={saveAccessConfigurationAction}
  history={data.history.map(event=>({id:event.id,when:new Intl.DateTimeFormat(locale,{dateStyle:'medium',timeStyle:'short',timeZone:'Asia/Kuala_Lumpur'}).format(new Date(event.at)),actorLabel:data.users.find(user=>user.id===event.actorId)?.label??t('unavailable'),operationLabel:t(`operations.${event.operation}`)}))}/></div>;
}
