/** Import-safe native enrollment prerequisite, never a login/session/provider simulator.
 * The guarded parent owns the disposable DB, HTTPS target and complete resource admission.
 * Secret inputs remain in memory; this helper creates no file, cookie, SMTP configuration or session.
 * Native bootstrap attests operator ownership; it does NOT prove external mailbox delivery. */
import {timingSafeEqual} from 'node:crypto';
import {sql} from 'drizzle-orm';
import {withTenant} from '../../db/client';
import {bootstrapInternalOwner} from '../../lib/internal-auth/bootstrap';
import {internalConfig,internalSelected,internalIssuer,INTERNAL_SESSION_COOKIE} from '../../lib/internal-auth/config';
import {loginKey} from '../../lib/internal-auth/service';
import type {AiDeliveryFixtureContext} from './ai-delivery-fixture-context';

export type AiDeliveryNativeNotificationIdentityInput=Readonly<{
 configuration:Readonly<{AUTH_PROVIDER:'internal';AUTH_PUBLIC_ORIGIN:string;AUTH_SESSION_KEY:string;AUTH_DEFAULT_ORGANIZATION:string}>;
 credential:Readonly<{organization:string;username:string;email:string;temporaryPassword:string}>;
 /** Explicit trusted fixture-operator enrollment attestation, never an HTTP/model email claim. */
 operatorOwnershipAttested:true;
}>;
const unavailable=():never=>{throw Error('Native notification identity fixture unavailable; preserve the owned fixture for private diagnosis.');};
function requireFact(condition:unknown):asserts condition{if(!condition)unavailable();}

export async function prepareAiDeliveryNativeNotificationIdentity(context:AiDeliveryFixtureContext,input:AiDeliveryNativeNotificationIdentityInput){
 // Capture only the closed private contract and actual operator before the first asynchronous step.
 const configuration={...input.configuration},credential={...input.credential},attested=input.operatorOwnershipAttested;
 const actor={...context.actors.operator,ctx:{...context.actors.operator.ctx,roles:context.actors.operator.ctx.roles?.slice(),grants:context.actors.operator.ctx.grants?.map(grant=>({...grant}))}};
 const {tenantId,companyId,today,owner}=context;
 try{
  requireFact(process.env.NODE_ENV!=='production'&&attested===true&&internalSelected(configuration)&&internalSelected());
  const supplied=internalConfig(configuration),runtime=internalConfig();
  requireFact(configuration.AUTH_PUBLIC_ORIGIN===supplied.origin&&supplied.origin===runtime.origin&&supplied.organization===runtime.organization);
  requireFact(timingSafeEqual(Buffer.from(supplied.key,'hex'),Buffer.from(runtime.key,'hex')));
  requireFact(typeof credential.organization==='string'&&credential.organization===credential.organization.trim().toLowerCase()&&/^[a-z0-9][a-z0-9-]{1,63}$/.test(credential.organization));
  requireFact(!runtime.organization||runtime.organization===credential.organization);
  requireFact(typeof credential.username==='string'&&credential.username===credential.username.trim().toLowerCase()&&/^[a-z0-9][a-z0-9._@+-]{2,63}$/.test(credential.username));
  requireFact(typeof credential.email==='string'&&credential.email===credential.email.trim().toLowerCase()&&/^\S+@[^\s@]+\.[^\s@]+$/.test(credential.email));
  requireFact(typeof credential.temporaryPassword==='string'); // Native bootstrap owns password policy/hash.
  requireFact(actor.ctx.tenantId===tenantId&&actor.ctx.userId===actor.userId&&actor.ctx.personId===actor.personId&&actor.personId&&actor.employmentId);
  requireFact(actor.ctx.entitlementsExempt===undefined&&actor.ctx.statutoryOverride===undefined);
  const issuer=internalIssuer(tenantId);
  const readActualOperator=()=>withTenant(actor.ctx,async tx=>{
   const [actual]=await tx.execute<{allowed:boolean}>(sql`select exists(
    select 1 from public.app_user u join public.person p on p.id=u.person_id and p.tenant_id=u.tenant_id
    join public.employment e on e.person_id=p.id and e.tenant_id=u.tenant_id
    join public.company c on c.id=e.company_id and c.tenant_id=u.tenant_id
    where u.id=${actor.userId}::uuid and u.id=app.current_user_id() and u.tenant_id=${tenantId}::uuid and u.tenant_id=app.current_tenant_id()
     and u.person_id=${actor.personId}::uuid and e.id=${actor.employmentId}::uuid and c.id=${companyId}::uuid
     and lower(p.primary_email)=${credential.email} and u.archived_at is null and not app.login_blocked(u.id)
     and e.hired_on<=${today}::date and (e.terminated_on is null or e.terminated_on>=${today}::date)
     and app.principal_snapshot_current() and app.is_group_admin()
     and exists(select 1 from public.role_assignment r where r.app_user_id=u.id and r.tenant_id=u.tenant_id and r.role='hr_admin' and r.company_id is null)
   ) as allowed`);
   requireFact(actual?.allowed===true);
  });
  await readActualOperator();
  // Read existence only, never decrypt private credentials or adopt an existing identity. The native
  // bootstrap independently locks namespaces and rechecks identity/authority before committing.
  const existing=await owner.client<{present:boolean}[]>`select
   exists(select 1 from public.app_external_identity where app_user_id=${actor.userId}::uuid)
   or exists(select 1 from public.app_internal_auth_record where record_key in (${'org:'+credential.organization},${'tenant:'+tenantId},${loginKey(credential.organization,credential.username)})) as present`;
  requireFact(existing[0]?.present===false);
  const native=await bootstrapInternalOwner(owner.client,{appUserId:actor.userId,organization:credential.organization,username:credential.username,email:credential.email,password:credential.temporaryPassword,installationOperator:false});
  requireFact(native.alreadyEnrolled===false&&native.tenantId===tenantId);
  await readActualOperator();
  const bound=await owner.client<{app_user_id:string;tenant_id:string}[]>`select app_user_id,tenant_id from app.principal_by_identity(${issuer},${native.subject})`;
  requireFact(bound.length===1&&bound[0].app_user_id===actor.userId&&bound[0].tenant_id===tenantId);
  return Object.freeze({
   kind:'native_internal_operator_enrollment' as const,tenantId,userId:actor.userId,personId:actor.personId,employmentId:actor.employmentId,
   issuer,subject:native.subject,organization:credential.organization,username:credential.username,email:credential.email,
   verification:'native_operator_ownership_attestation_not_mailbox_delivery' as const,installationOperator:false as const,
   browser:Object.freeze({origin:runtime.origin,loginRoute:'/login' as const,sessionCookie:INTERNAL_SESSION_COOKIE,requiresHttps:true as const,passwordChangePending:true as const,mfaEnrollmentPending:true as const,realBrowserLoginPending:true as const,notificationRoute:'/assistant/notifications' as const,humanConsentPending:true as const}),
   sessionCreated:false as const,notificationPreferencesChanged:false as const,emailDeliveryVerified:false as const,
  });
 }catch{return unavailable();}
}
