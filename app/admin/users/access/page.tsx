import {getLocale,getTranslations} from 'next-intl/server';
import {requireAccessConfiguration} from '@/lib/access-configuration-authz';
import {AccessConfigurationEditor} from '../access-editor';
import {previewAccessConfigurationAction,saveAccessConfigurationAction} from './actions';
import {SecurityBackLink} from '../security-page';
const capabilityKeys:Record<string,string>={'access.system_admin':'systemAdministrator','access.configure':'configure','workforce.view':'workforceView','workforce.maintain':'workforceMaintain','workforce.movement.delete':'movementDelete','profile.review':'profileReview','probation.module':'probationModule'};
export default async function AccessConfigurationPage(){
 const [{session,data},t,locale]=await Promise.all([
  requireAccessConfiguration(),getTranslations('accessConfiguration'),getLocale(),
 ]);
 const activeUserIds=new Set(data.snapshot.users.filter(user=>user.active).map(user=>user.id));
 const userLabels=new Map(data.users.map(user=>[user.id,user.label]));
 const inactive=t('inactive'),unavailable=t('unavailable');
 const users=data.users.map(user=>({...user,label:activeUserIds.has(user.id)?user.label:`${user.label} · ${inactive}`}));
 const formatTime=new Intl.DateTimeFormat(locale,{dateStyle:'medium',timeStyle:'short',timeZone:'Asia/Kuala_Lumpur'});
 return <div className="mx-auto max-w-5xl space-y-6"><SecurityBackLink/><AccessConfigurationEditor actorUserId={session.userId!}
  snapshot={data.snapshot} scopeFingerprint={data.scopeFingerprint} users={users} companies={data.companies}
  capabilities={data.capabilities.map(cap=>({...cap,label:capabilityKeys[cap.id]?t(`capabilities.${capabilityKeys[cap.id]}`):t('unavailable')}))}
  previewAction={previewAccessConfigurationAction} saveAction={saveAccessConfigurationAction}
  history={data.history.map(event=>({id:event.id,when:formatTime.format(new Date(event.at)),actorLabel:(event.actorId?userLabels.get(event.actorId):undefined)??unavailable,operationLabel:t(`operations.${event.operation}`)}))}/></div>;
}
