/** Narrow snapshot capability for the existing notification projector and delivery revalidation.
 * Sweeps already hold an explicit maintenance connection. Web requests keep ordinary scoped RLS.
 * Neither a context role nor an app-controlled GUC can mint this connection-backed capability. */
import {and,asc,eq,isNotNull,sql} from 'drizzle-orm';
import type {SessionContext,Tx,createDb} from '../db/client';
import {notice,noticeRecipient} from '../db/schema';

export type NoticeRecipientReader=(noticeId:string)=>Promise<string[]>;
const proof=Symbol('notice-sweep-snapshot');
export type NoticeSweepAccess={readonly [proof]:true;readonly tenantId:string;readonly recipients:NoticeRecipientReader};
type Connection=Pick<ReturnType<typeof createDb>,'withTenant'>;
const uuid=(value:string)=>/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value);

async function snapshotIds(tx:Tx,tenantId:string,noticeId:string){
 if(!uuid(noticeId))throw Error('Notice snapshot is unavailable.');
 const rows=await tx.select({id:noticeRecipient.employmentId}).from(noticeRecipient)
  .innerJoin(notice,and(eq(notice.id,noticeRecipient.noticeId),eq(notice.tenantId,noticeRecipient.tenantId)))
  .where(and(eq(noticeRecipient.tenantId,tenantId),eq(noticeRecipient.noticeId,noticeId),isNotNull(notice.publishedAt)))
  .orderBy(asc(noticeRecipient.employmentId),asc(noticeRecipient.id));
 return rows.map(row=>row.id);
}

/** A scoped web projector must not advance a tenant-wide cursor after reading a partial snapshot.
 * Throwing rolls back that projection; the configured minute sweep can process it with its capability.
 */
export async function noticeNotificationRecipientsTx(tx:Tx,noticeId:string):Promise<string[]>{
 const [scope]=await tx.execute(sql`SELECT app.current_tenant_id()::text AS tenant_id,app.can_manage_notice(${noticeId}::uuid) AS allowed`) as unknown as {tenant_id:string;allowed:boolean}[];
 if(!scope?.allowed)throw Error('Notice projection requires the complete authorized audience snapshot.');
 return snapshotIds(tx,scope.tenant_id,noticeId);
}

async function assertSweepConnection(tx:Tx){
 const [role]=await tx.execute(sql`
  SELECT current_user::text AS role,session_user::text AS login,
   (p.rolsuper OR p.rolbypassrls OR pg_has_role(current_user,c.relowner,'USAGE'))
   AND (s.rolsuper OR s.rolbypassrls OR pg_has_role(session_user,c.relowner,'USAGE')) AS privileged
  FROM pg_catalog.pg_roles p CROSS JOIN pg_catalog.pg_roles s CROSS JOIN pg_catalog.pg_class c
  WHERE p.rolname=current_user AND s.rolname=session_user AND c.oid='public.notice_recipient'::regclass
 `) as unknown as {role:string;login:string;privileged:boolean}[];
 if(!role?.privileged||role.role==='ai_hr_app'||role.login==='ai_hr_app')throw Error('Notice sweep access requires an explicit privileged database connection.');
}

export async function createNoticeSweepAccess(ctx:SessionContext,connection:Connection):Promise<NoticeSweepAccess>{
 if(ctx.userId||!uuid(ctx.tenantId))throw Error('Notice sweep access requires a tenant-bound maintenance context.');
 const bound={...ctx,roles:[...(ctx.roles??[])],grants:ctx.grants?.map(grant=>({...grant}))};
 await connection.withTenant(bound,assertSweepConnection,{readOnlySnapshot:true});
 return Object.freeze({[proof]:true as const,tenantId:bound.tenantId,
  recipients:(noticeId:string)=>connection.withTenant(bound,async tx=>{await assertSweepConnection(tx);return snapshotIds(tx,bound.tenantId,noticeId);},{readOnlySnapshot:true})});
}

export function noticeSweepReader(ctx:SessionContext,access?:NoticeSweepAccess):NoticeRecipientReader|undefined{
 if(!access)return undefined;
 if(ctx.userId||access[proof]!==true||access.tenantId!==ctx.tenantId)throw Error('Notice sweep access does not match this maintenance context.');
 return access.recipients;
}
