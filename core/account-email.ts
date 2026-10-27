/** Account requests own their business state; this ledger owns only email delivery. */
import {createHash} from 'node:crypto';
import {sql} from 'drizzle-orm';
import {z} from 'zod';
import {emailDisplayClock} from '../lib/email-display-clock';
import {client,withTenant,type SessionContext} from '../db/client';
import type {IdentityEmailActor} from '../lib/identity/email-model';
import {AccountEmailDeliveryError,type AccountEmailProvider,type AccountEmailDeliveryView,type AccountEmailError,type AccountEmailReadiness} from '../lib/account-email-model';

/** No business transaction spans the provider call. A lost result remains held, never auto-retried. */
export async function attemptAccountEmail(id:string,leaseToken:string,provider:AccountEmailProvider,invitationToken?:string):Promise<void>{
 const hash=invitationToken?createHash('sha256').update(invitationToken).digest('hex'):null;
 const finish=(status:'sent'|'failed'|'skipped',error:AccountEmailError|null)=>client`select app.account_email_finish(${id}::uuid,${leaseToken}::uuid,${status},${error})`;
 try{
  const [target]=await client<{kind:'invitation'|'recovery';email:string}[]>`select * from app.account_email_target(${id}::uuid,${leaseToken}::uuid,${hash})`;
  if(!target){await finish('skipped','notEligible');return;}
  let readiness:AccountEmailReadiness;
  try{readiness=await provider.emailReadiness?.()??null;}catch{readiness='providerUnavailable';}
  if(readiness){await finish('failed',readiness);return;}
  const [start]=await client<{started:boolean}[]>`select app.account_email_start(${id}::uuid,${leaseToken}::uuid,${hash}) as started`;
  if(!start?.started)return;
  try{
   if(target.kind==='invitation'){
    if(!invitationToken||!/^[A-Za-z0-9_-]{43}$/.test(invitationToken))throw new AccountEmailDeliveryError('notEligible');
    await provider.sendInvitation(target.email,`/invite/${invitationToken}/activate`,{deliveryId:id,leaseToken});
   }else await provider.sendPasswordReset(target.email,{deliveryId:id,leaseToken});
  }catch(error){await finish('failed',error instanceof AccountEmailDeliveryError?error.code:'uncertain');return;}
  await finish('sent',null);
 }catch{
  // A committed invitation or recovery request survives a delivery-ledger/provider outage. An
  // abandoned lease is recorded as unavailable/uncertain when an authorized admin opens the log.
 }
}

/** Recovery rows require an exact operator from a verified identity session, provided only by the server. */
export async function readAccountEmailDeliveries(ctx:SessionContext,actor?:IdentityEmailActor):Promise<AccountEmailDeliveryView[]>{
 if(actor&&(actor.userId!==ctx.userId||actor.tenantId!==ctx.tenantId))throw Error('Email administrator identity does not match the session.');
 return withTenant(ctx,async tx=>{
  const rows=await tx.execute<{id:string;kind:'invitation'|'recovery';email:string;status:'pending'|'sent'|'failed'|'skipped';attempts:number;error:AccountEmailError|null;created_at:Date;can_retry:boolean}>(sql`select * from app.account_email_recent(${actor?.issuer??null},${actor?.subject??null})`);
  return rows.map(row=>({id:row.id,kind:row.kind,email:row.email,status:row.status,attempts:row.attempts,error:row.error,createdAt:new Date(row.created_at),canRetry:row.can_retry}));
 });
}

const historyFilters=z.object({fromDate:z.iso.date().optional(),toDate:z.iso.date().optional(),before:z.string().max(200).optional()}).strict();
export type AccountEmailHistoryFilters=z.infer<typeof historyFilters>;
export async function readAccountEmailHistory(ctx:SessionContext,actor?:IdentityEmailActor,input:AccountEmailHistoryFilters={}){
 if(actor&&(actor.userId!==ctx.userId||actor.tenantId!==ctx.tenantId))throw Error('Email administrator identity does not match the session.');
 const filters=historyFilters.parse(input);if(filters.fromDate&&filters.toDate&&filters.fromDate>filters.toDate)throw Error('Invalid email history date range.');
 const cursor=filters.before?z.tuple([z.iso.datetime({offset:true}),z.uuid()]).parse(JSON.parse(Buffer.from(filters.before,'base64url').toString())):null;
 const clock=emailDisplayClock();
 const rows=await withTenant(ctx,tx=>tx.execute<{id:string;kind:'invitation'|'recovery';email:string;status:'pending'|'sent'|'failed'|'skipped';attempts:number;error:AccountEmailError|null;created_at:Date;cursor_created_at:string;can_retry:boolean;resend_unavailable:string|null}>(sql`select * from app.account_email_history(${actor?.issuer??null},${actor?.subject??null},${filters.fromDate??null}::date,${filters.toDate??null}::date,${clock.timeZone},${cursor?.[0]??null}::timestamptz,${cursor?.[1]??null}::uuid)`));
 const hasMore=rows.length>25,page=rows.slice(0,25),last=page.at(-1);
 const items:AccountEmailDeliveryView[]=page.map(row=>({id:row.id,kind:row.kind,email:row.email,status:row.status,attempts:row.attempts,error:row.error,createdAt:new Date(row.created_at),canRetry:row.can_retry,resendUnavailable:row.resend_unavailable==='superseded'?'superseded':row.resend_unavailable==='closed'?'closed':row.resend_unavailable==='pending'?'pending':undefined}));
 // A JS Date truncates PostgreSQL microseconds. Preserve the database cursor verbatim so rows
 // sharing the boundary millisecond cannot disappear between pages.
 return {items,hasMore,nextCursor:hasMore&&last?Buffer.from(JSON.stringify([last.cursor_created_at,last.id])).toString('base64url'):undefined};
}
