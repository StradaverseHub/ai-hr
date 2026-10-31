import {getLocale,getTranslations} from 'next-intl/server';
import {requireAccessConfiguration} from '@/lib/access-configuration-authz';
import {AccessConfigurationEditor} from '../access-editor';
import {previewAccessConfigurationAction,saveAccessConfigurationAction} from './actions';
import {SecurityBackLink} from '../security-page';
const capabilityKeys:Record<string,string>={'access.system_admin':'systemAdministrator','access.configure':'configure','workforce.view':'workforceView','workforce.maintain':'workforceMaintain','profile.review':'profileReview'};
export default async function AccessConfigurationPage(){
 const {session,data}=await requireAccessConfiguration(),t=await getTranslations('accessConfiguration'),locale=await getLocale();
 const users=data.users.map(user=>({...user,label:data.snapshot.users.find(row=>row.id===user.id)?.active?user.label:`${user.label} · ${t('inactive')}`}));
 return <div className="mx-auto max-w-5xl space-y-6"><SecurityBackLink/><AccessConfigurationEditor actorUserId={session.userId!}
  snapshot={data.snapshot} scopeFingerprint={data.scopeFingerprint} users={users} companies={data.companies}
  capabilities={data.capabilities.map(cap=>({...cap,label:capabilityKeys[cap.id]?t(`capabilities.${capabilityKeys[cap.id]}`):t('unavailable')}))}
  previewAction={previewAccessConfigurationAction} saveAction={saveAccessConfigurationAction}
  history={data.history.map(event=>({id:event.id,when:new Intl.DateTimeFormat(locale,{dateStyle:'medium',timeStyle:'short',timeZone:'Asia/Kuala_Lumpur'}).format(new Date(event.at)),actorLabel:data.users.find(user=>user.id===event.actorId)?.label??t('unavailable'),operationLabel:t(`operations.${event.operation}`)}))}/></div>;
}
