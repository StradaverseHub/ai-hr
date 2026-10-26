/** Persistent scoped challenges. Issuance/consumption alone is never an integrity verdict. */
import {createHash,randomBytes} from 'node:crypto';
import {and,eq,gt,isNull,sql} from 'drizzle-orm';
import {z} from 'zod';
import type {SessionContext,Tx} from '../db/client';
import {mobileIntegrityChallenge} from '../db/schema';
import {actorOf,appendEvent} from '../db/events';
import {RequestBudgetExceeded} from '../lib/request-budget';
import {withAttendanceTenant} from './module-gate';
import {myOwnEmploymentSubjectsTx} from './read';
import {OwnClockEmploymentUnavailableError} from './attendance-clock-subject';

const uuid=z.string().uuid().transform(value=>value.toLowerCase());
const inputSchema=z.object({employmentId:uuid,requestId:uuid,appInstallationId:uuid,
  purpose:z.enum(['device.enrollment','clock.online']),bindingHash:z.string().length(64).regex(/^[a-f0-9]{64}$/)}).strict();
export type IntegrityChallengeIntent=z.infer<typeof inputSchema>;
type Row=typeof mobileIntegrityChallenge.$inferSelect;
export class IntegrityChallengeError extends Error{
  constructor(readonly reason:'not_found'|'binding_conflict'|'expired'|'time_unavailable'){super('Integrity challenge unavailable');this.name='IntegrityChallengeError';}
}
async function own(tx:Tx,ctx:SessionContext,employmentId:string){
  if(!ctx.userId||!ctx.personId||!(await myOwnEmploymentSubjectsTx(tx,ctx,{profileEdit:true})).some(row=>row.employmentId===employmentId))throw new OwnClockEmploymentUnavailableError();
}
async function stamp(tx:Tx){
  const rows=await tx.execute(sql`select clock_timestamp() stamp`),value=rows[0]?.stamp;
  const date=value instanceof Date?value:new Date(String(value));
  if(!Number.isFinite(date.getTime()))throw new IntegrityChallengeError('time_unavailable');return date;
}
function matches(row:Row,intent:IntegrityChallengeIntent){
  if(row.employmentId!==intent.employmentId||row.appInstallationId!==intent.appInstallationId||row.purpose!==intent.purpose||row.bindingHash!==intent.bindingHash)
    throw new IntegrityChallengeError('binding_conflict');
}
function view(row:Row,now:Date){
  if(now<row.issuedAt)throw new IntegrityChallengeError('time_unavailable');
  return {id:row.id,requestId:row.requestId,installationId:row.installationId,actorId:row.actorId,employmentId:row.employmentId,
    appInstallationId:row.appInstallationId,purpose:row.purpose,bindingHash:row.bindingHash,nonce:row.nonce,
    issuedAt:row.issuedAt.toISOString(),expiresAt:row.expiresAt.toISOString(),
    state:row.consumedAt?'consumed' as const:now>=row.expiresAt?'expired' as const:'active' as const};
}
export type IntegrityChallengeView=ReturnType<typeof view>;

export async function readOwnIntegrityChallenge(ctx:SessionContext,input:IntegrityChallengeIntent&{challengeId:string}):Promise<IntegrityChallengeView>{
  const {challengeId,...raw}=input,intent=inputSchema.parse(raw),id=uuid.parse(challengeId);
  return withAttendanceTenant(ctx,async tx=>{
    await own(tx,ctx,intent.employmentId);
    const [row]=await tx.select().from(mobileIntegrityChallenge).where(and(eq(mobileIntegrityChallenge.id,id),eq(mobileIntegrityChallenge.tenantId,ctx.tenantId),
      eq(mobileIntegrityChallenge.actorId,ctx.userId!),eq(mobileIntegrityChallenge.requestId,intent.requestId))).limit(1);
    if(!row)throw new IntegrityChallengeError('not_found');matches(row,intent);return view(row,await stamp(tx));
  });
}

/** bindingHash is computed by the trusted enrollment/command owner, not copied from an HTTP body.
 * Same actor/request ID retains the original challenge, including expired/consumed terminal states.
 */
export async function issueOwnIntegrityChallenge(ctx:SessionContext,input:IntegrityChallengeIntent):Promise<IntegrityChallengeView>{
  const intent=inputSchema.parse(input);
  return withAttendanceTenant(ctx,async tx=>{
    await own(tx,ctx,intent.employmentId);
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${ctx.tenantId+':mobile-integrity:'+ctx.userId},0))`);
    const [existing]=await tx.select().from(mobileIntegrityChallenge).where(and(eq(mobileIntegrityChallenge.tenantId,ctx.tenantId),
      eq(mobileIntegrityChallenge.actorId,ctx.userId!),eq(mobileIntegrityChallenge.requestId,intent.requestId))).limit(1);
    const now=await stamp(tx);
    if(existing){matches(existing,intent);return view(existing,now);}
    const pending=await tx.select({expiresAt:mobileIntegrityChallenge.expiresAt}).from(mobileIntegrityChallenge).where(and(
      eq(mobileIntegrityChallenge.tenantId,ctx.tenantId),eq(mobileIntegrityChallenge.actorId,ctx.userId!),isNull(mobileIntegrityChallenge.consumedAt),
      gt(mobileIntegrityChallenge.expiresAt,now))).orderBy(mobileIntegrityChallenge.expiresAt).limit(4);
    if(pending.length===4)throw new RequestBudgetExceeded(Math.max(1,Math.ceil((pending[0].expiresAt.getTime()-now.getTime())/1000)));
    // Reuse the shared limiter in THIS transaction; a second pooled connection could deadlock
    // behind concurrent callers waiting for this actor's advisory lock.
    const key=createHash('sha256').update(JSON.stringify(['mobile-integrity-issue',ctx.tenantId,ctx.userId,intent.purpose])).digest('hex');
    const enrollment=intent.purpose==='device.enrollment';
    const budget=await tx.execute(sql`select app.consume_request_budget(${key},${enrollment?5:30},${enrollment?3600:60}) retry_after`);
    const retry=Number(budget[0]?.retry_after);
    if(!Number.isFinite(retry)||retry<0)throw new Error('Integrity admission unavailable');
    if(retry>0)throw new RequestBudgetExceeded(Math.max(1,Math.ceil(retry)));
    const identity=await tx.execute(sql`select app.mobile_integrity_installation_id() id`);
    const installationId=z.string().uuid().parse(identity[0]?.id);
    const [row]=await tx.insert(mobileIntegrityChallenge).values({...intent,tenantId:ctx.tenantId,actorId:ctx.userId!,installationId,
      nonce:randomBytes(32).toString('base64url'),issuedAt:now,expiresAt:new Date(now.getTime()+(enrollment?600000:120000))}).returning();
    await appendEvent(tx,{tenantId:ctx.tenantId,aggregateType:'mobile-integrity-challenge',aggregateId:row.id,
      eventType:'mobile.integrity.challenge.issued',actor:actorOf(ctx),subjectEmploymentId:intent.employmentId,payload:{purpose:intent.purpose}});
    return view(row,now);
  });
}

/** Internal transaction seam: the caller verifies proof against the stored binding BEFORE consuming.
 * Its callback must persist the authoritative outcome using this tx, never open another transaction
 * or perform vendor network calls. A throw rolls back consumption, callback writes and audit together.
 * Repeated consumption never reruns the callback; the caller reconciles its own outcome/receipt.
 */
export async function consumeOwnIntegrityChallenge<T>(ctx:SessionContext,input:IntegrityChallengeIntent&{challengeId:string},
  operation:(tx:Tx,challenge:IntegrityChallengeView)=>Promise<T>):Promise<{state:'consumed';value:T;consumedAt:string}|{state:'already_consumed';consumedAt:string}>{
  const {challengeId,...raw}=input,intent=inputSchema.parse(raw),id=z.string().uuid().parse(challengeId);
  return withAttendanceTenant(ctx,async tx=>{
    await own(tx,ctx,intent.employmentId);
    const [row]=await tx.select().from(mobileIntegrityChallenge).where(and(eq(mobileIntegrityChallenge.id,id),eq(mobileIntegrityChallenge.tenantId,ctx.tenantId),
      eq(mobileIntegrityChallenge.actorId,ctx.userId!),eq(mobileIntegrityChallenge.requestId,intent.requestId))).limit(1).for('update');
    if(!row)throw new IntegrityChallengeError('not_found');matches(row,intent);
    if(row.consumedAt)return {state:'already_consumed' as const,consumedAt:row.consumedAt.toISOString()};
    const now=await stamp(tx);if(now>=row.expiresAt)throw new IntegrityChallengeError('expired');
    const challenge=view(row,now);
    const [consumed]=await tx.update(mobileIntegrityChallenge).set({consumedAt:now}).where(eq(mobileIntegrityChallenge.id,row.id)).returning({id:mobileIntegrityChallenge.id});
    // A row lock does not make a later RLS refusal or database write veto successful.
    if(!consumed)throw new IntegrityChallengeError('not_found');
    const value=await operation(tx,challenge);
    await appendEvent(tx,{tenantId:ctx.tenantId,aggregateType:'mobile-integrity-challenge',aggregateId:row.id,
      eventType:'mobile.integrity.challenge.consumed',actor:actorOf(ctx),subjectEmploymentId:intent.employmentId,payload:{purpose:intent.purpose}});
    return {state:'consumed' as const,value,consumedAt:now.toISOString()};
  });
}
