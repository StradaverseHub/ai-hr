/** Board 0735d1b7 — the activation page of a person waiting for a login (Security Center > Users > View/Edit on a
 * Pending Activation row). Read only; group administrators only, the same people who prepare logins today.
 *
 * A person qualifies exactly as the Users list's activation candidates do (core/employee-user-activation.ts): a person
 * of the tenant with no login whose employments are not all ended (a person with no employment, an external
 * contact, qualifies). Anyone else is refused, so the page can never be used to act on a login or a leaver. The
 * page then shows what already exists: an open invitation with its email delivery, or a manual setup in progress.
 * One tenant transaction: the person statement, then the manual-setup proof and list (core/manual-identity-setup.ts). */
import {sql} from 'drizzle-orm';
import {withTenant,type SessionContext} from '../db/client';
import {manualSetupPersonIdsTx} from './manual-identity-setup';

export type ActivationInvitation={id:string;email:string;role:string;companyId:string|null;createdAt:string;expiresAt:string;
 deliveryId:string|null;deliveryStatus:'pending'|'sent'|'failed'|'skipped'|null;deliverySentAt:string|null;deliveryError:string|null};
export type ActivationPerson={id:string;name:string;email:string|null;employeeCode:string|null;hasEmployment:boolean;profileEmploymentId:string|null;
 invitation:ActivationInvitation|null;setupInProgress:boolean};

const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function groupAdmin(ctx:SessionContext){
 const grants=ctx.grants??(ctx.roles??[]).map(role=>({role,companyId:null as string|null}));
 return grants.some(g=>g.role==='super_admin'||(g.role==='hr_admin'&&g.companyId==null));
}
const iso=(v:Date|string|null)=>v===null?null:new Date(v).toISOString();

/** The person, or null when they are not an activation candidate (or not visible). Throws for a non-group-admin. */
export async function readActivationPerson(ctx:SessionContext,personId:string):Promise<ActivationPerson|null>{
 if(!groupAdmin(ctx))throw new Error('Only a group administrator can prepare employee logins.');
 if(!UUID.test(personId))return null;
 return withTenant(ctx,async tx=>{
  const [row]=await tx.execute<{id:string;name:string;email:string|null;employee_code:string|null;has_employment:boolean;profile_employment_id:string|null;
   invitation_id:string|null;invitation_email:string|null;invitation_role:string|null;invitation_company_id:string|null;invitation_created_at:Date|string|null;invitation_expires_at:Date|string|null;
   delivery_id:string|null;delivery_status:ActivationInvitation['deliveryStatus'];delivery_sent_at:Date|string|null;delivery_error:string|null}>(sql`
   select p.id::text,p.full_name as name,nullif(trim(p.primary_email),'') as email,
    (select string_agg(distinct e.employee_code,', ') from employment e where e.tenant_id=p.tenant_id and e.person_id=p.id and e.terminated_on is null) as employee_code,
    exists(select 1 from employment e where e.tenant_id=p.tenant_id and e.person_id=p.id) as has_employment,
    (select e.id::text from employment e where e.tenant_id=p.tenant_id and e.person_id=p.id order by (e.terminated_on is null) desc,e.hired_on desc nulls last,e.id limit 1) as profile_employment_id,
    i.id::text as invitation_id,i.email as invitation_email,i.role::text as invitation_role,i.company_id::text as invitation_company_id,i.created_at as invitation_created_at,i.expires_at as invitation_expires_at,
    d.id::text as delivery_id,d.status::text as delivery_status,d.sent_at as delivery_sent_at,d.last_error as delivery_error
   from person p
   left join lateral (select * from app_invitation i where i.tenant_id=p.tenant_id and i.person_id=p.id and i.status='pending' order by i.created_at desc,i.id desc limit 1) i on true
   left join account_email_delivery d on d.invitation_id=i.id and d.kind='invitation'
   where p.tenant_id=${ctx.tenantId}::uuid and p.id=${personId}::uuid
    and not exists(select 1 from app_user u where u.tenant_id=p.tenant_id and u.person_id=p.id)
    -- Same rule as isLoginBlocked: a person whose every employment has ended (or is blacklisted) is not a candidate.
    and (not exists(select 1 from employment e where e.tenant_id=p.tenant_id and e.person_id=p.id)
     or exists(select 1 from employment e where e.tenant_id=p.tenant_id and e.person_id=p.id and e.blacklisted_at is null
      and (least(e.resignation_date,e.last_working_date,e.terminated_on) is null or current_date<=least(e.resignation_date,e.last_working_date,e.terminated_on))))`);
  if(!row)return null;
  const setup=(await manualSetupPersonIdsTx(tx,ctx)).includes(row.id);
  return{id:row.id,name:row.name,email:row.email,employeeCode:row.employee_code,hasEmployment:Boolean(row.has_employment),profileEmploymentId:row.profile_employment_id,
   setupInProgress:setup,
   invitation:row.invitation_id?{id:row.invitation_id,email:row.invitation_email??'',role:row.invitation_role??'employee',companyId:row.invitation_company_id,
    createdAt:iso(row.invitation_created_at)!,expiresAt:iso(row.invitation_expires_at)!,deliveryId:row.delivery_id,deliveryStatus:row.delivery_status,
    deliverySentAt:iso(row.delivery_sent_at),deliveryError:row.delivery_error}:null};
 });
}
