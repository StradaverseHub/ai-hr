/** Connection-backed, tenant-bound Notice reads for the canonical notification engine. */
import {and,asc,eq,isNotNull,like,sql} from 'drizzle-orm';
import type {SessionContext,Tx,createDb} from '../db/client';
import {domainEvent,employment,notice,noticeRecipient} from '../db/schema';

export type NoticeRecipientReader=(noticeId:string)=>Promise<string[]>;
export type NoticeEvent=Pick<typeof domainEvent.$inferSelect,'id'|'aggregateId'|'eventType'|'subjectEmploymentId'|'payload'>;
export type NoticeEventReader=(eventId:string)=>Promise<NoticeEvent|undefined>;
const proof=Symbol('notice-sweep-snapshot');
export type NoticeSweepAccess={readonly [proof]:true;readonly tenantId:string;readonly recipients:NoticeRecipientReader;readonly eventById:NoticeEventReader};
const minted=new WeakSet<NoticeSweepAccess>();
export type NotificationSweepConnection=Pick<ReturnType<typeof createDb>,'withTenant'>;
const uuid=(value:string)=>/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value);

/** Caller supplies an already authenticated maintenance transaction; ordinary callers remain RLS-bound. */
export async function noticeSnapshotIdsTx(tx:Tx,tenantId:string,noticeId:string){
 if(!uuid(noticeId))throw Error('Notice snapshot is unavailable.');
 const rows=await tx.select({id:noticeRecipient.employmentId}).from(noticeRecipient)
  .innerJoin(notice,and(eq(notice.id,noticeRecipient.noticeId),eq(notice.tenantId,noticeRecipient.tenantId)))
  .innerJoin(employment,and(eq(employment.id,noticeRecipient.employmentId),eq(employment.tenantId,noticeRecipient.tenantId)))
  .where(and(eq(noticeRecipient.tenantId,tenantId),eq(noticeRecipient.noticeId,noticeId),isNotNull(notice.publishedAt)))
  .orderBy(asc(noticeRecipient.employmentId),asc(noticeRecipient.id));
 return rows.map(row=>row.id);
}

export async function noticeNotificationRecipientsTx(tx:Tx,noticeId:string):Promise<string[]>{
 const [scope]=await tx.execute(sql`SELECT app.current_tenant_id()::text AS tenant_id,app.can_manage_notice(${noticeId}::uuid) AS allowed`) as unknown as {tenant_id:string;allowed:boolean}[];
 if(!scope?.allowed)throw Error('Notice projection requires the complete authorized audience snapshot.');
 return noticeSnapshotIdsTx(tx,scope.tenant_id,noticeId);
}

/** Inline catalog proof also works before the unshipped migration reaches the server. SECURITY DEFINER
 * current_user is deliberately excluded: both the login and its explicitly selected role must own the
 * protected storage (without FORCE RLS), or hold PostgreSQL's real bypass authority. */
export async function assertNotificationSweepConnection(tx:Tx):Promise<string>{
 const [role]=await tx.execute(sql`
  WITH actor AS (
   SELECT session_user::text AS login,current_setting('role',true) AS prior_role,
    coalesce(nullif(nullif(current_setting('role',true),'none'),''),session_user::text) AS effective
  )
  SELECT login,effective,prior_role,coalesce((
   SELECT count(*)=3 AND bool_and(
    (p.rolsuper OR p.rolbypassrls OR (NOT c.relforcerowsecurity AND pg_has_role(a.effective::name,c.relowner,'USAGE')))
    AND (s.rolsuper OR s.rolbypassrls OR (NOT c.relforcerowsecurity AND pg_has_role(a.login::name,c.relowner,'USAGE'))))
   FROM pg_catalog.pg_roles p CROSS JOIN pg_catalog.pg_roles s CROSS JOIN pg_catalog.pg_class c
   WHERE p.rolname=a.effective::name AND s.rolname=a.login::name
    AND c.oid IN ('public.notice_recipient'::regclass,'public.domain_event'::regclass,'public.notification_cursor'::regclass)
  ),false) AS privileged FROM actor a
 `) as unknown as {login:string;effective:string;prior_role:string;privileged:boolean}[];
 if(!role?.privileged||role.effective==='ai_hr_app'||role.login==='ai_hr_app')throw Error('Notice sweep access requires an explicit privileged database connection.');
 return role.prior_role||'none';
}

export async function createNoticeSweepAccess(ctx:SessionContext,connection:NotificationSweepConnection):Promise<NoticeSweepAccess>{
 if(ctx.userId||!uuid(ctx.tenantId))throw Error('Notice sweep access requires a tenant-bound maintenance context.');
 const bound={...ctx,roles:[...(ctx.roles??[])],grants:ctx.grants?.map(grant=>({...grant}))};
 await connection.withTenant(bound,assertNotificationSweepConnection,{readOnlySnapshot:true});
 const access:NoticeSweepAccess=Object.freeze({[proof]:true as const,tenantId:bound.tenantId,
  recipients:(noticeId:string)=>connection.withTenant(bound,async tx=>{await assertNotificationSweepConnection(tx);return noticeSnapshotIdsTx(tx,bound.tenantId,noticeId);},{readOnlySnapshot:true}),
  eventById:(eventId:string)=>connection.withTenant(bound,async tx=>{
   await assertNotificationSweepConnection(tx);
   if(!uuid(eventId))throw Error('Notice source event is unavailable.');
   const [event]=await tx.select({id:domainEvent.id,aggregateId:domainEvent.aggregateId,eventType:domainEvent.eventType,subjectEmploymentId:domainEvent.subjectEmploymentId,payload:domainEvent.payload})
    .from(domainEvent).where(and(eq(domainEvent.id,eventId),eq(domainEvent.tenantId,bound.tenantId),eq(domainEvent.aggregateType,'notice'),like(domainEvent.eventType,'notice.%'))).limit(1);
   return event;
  },{readOnlySnapshot:true})});
 minted.add(access);return access;
}

function assertAccess(ctx:SessionContext,access:NoticeSweepAccess){
 if(ctx.userId||!minted.has(access)||access[proof]!==true||access.tenantId!==ctx.tenantId)throw Error('Notice sweep access does not match this maintenance context.');
}
export function noticeSweepReader(ctx:SessionContext,access?:NoticeSweepAccess):NoticeRecipientReader|undefined{
 if(!access)return undefined;assertAccess(ctx,access);return access.recipients;
}
export function noticeSweepEventReader(ctx:SessionContext,access?:NoticeSweepAccess):NoticeEventReader|undefined{
 if(!access)return undefined;assertAccess(ctx,access);return access.eventById;
}
