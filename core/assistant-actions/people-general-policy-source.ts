/** Unexposed source. Native whole-organisation authority and logical revision remain the owners. */
import {createHash} from 'node:crypto';
import {sql} from 'drizzle-orm';
import {z} from 'zod';
import type {SessionContext,Tx} from '../../db/client';
import {savePeopleGeneral,savePeopleGeneralObservedTx} from '../people-general';
import {PeopleGeneralPolicyHuman as Human,PeopleGeneralPolicyValues as Values,PeopleGeneralPolicyReview as Review,PeopleGeneralPolicyNativeConfirmation as Confirmation,PeopleGeneralPolicyReceipt as Receipt} from '../../lib/assistant-actions/people-general-policy-contract';
export class PeopleGeneralPolicyUnavailable extends Error{constructor(){super('Reopen People General settings to review the current organisation policy.');this.name='PeopleGeneralPolicyUnavailable';}}
export const peopleGeneralPolicyUnavailable=():never=>{throw new PeopleGeneralPolicyUnavailable();};
const fail=peopleGeneralPolicyUnavailable;
const Source=z.object({tenantId:z.guid(),tenantName:z.string(),policy:Values,revision:z.guid().nullable(),actor:z.object({userId:z.guid(),personId:z.guid().nullable()}).strict(),authority:z.unknown()}).strict();
const Observation=z.object({tenantId:z.guid(),userId:z.guid(),before:Values,after:Values,beforeRevision:z.guid().nullable(),revision:z.guid(),eventId:z.guid(),insertedPolicy:z.boolean()}).strict();
type Snapshot=z.infer<typeof Source>;
const same=(a:unknown,b:unknown)=>JSON.stringify(a)===JSON.stringify(b);
function identity(s:Snapshot,ctx:SessionContext){if(s.tenantId!==ctx.tenantId||s.actor.userId!==ctx.userId||s.actor.personId!==(ctx.personId??null))return fail();return s;}
async function read(tx:Tx,ctx:SessionContext){const [row]=await tx.execute<{source:unknown}>(sql`select app.people_general_policy_review_source() as source`);return identity(Source.parse(row?.source),ctx);}
export async function lockPeopleGeneralPolicySourceTx(tx:Tx,ctx:SessionContext){const [row]=await tx.execute<{source:unknown}>(sql`select app.people_general_policy_review_lock() as source`);return identity(Source.parse(row?.source),ctx);}
export async function preparePeopleGeneralPolicyTx(tx:Tx,ctx:SessionContext,value:unknown){
 const content=Human.parse(structuredClone(value)),s=await lockPeopleGeneralPolicySourceTx(tx,ctx);if(!same(content.expected,s.policy))return fail();
 // Never materialize defaults to acquire an absence lock. Native NULL-revision UPSERT/CAS
 // decides whether an intervening admission has made this initial baseline stale.
 await tx.execute(sql`savepoint people_general_policy_native_preview`);
 try{const saved=await savePeopleGeneral(ctx,{...content.desired,revision:s.revision},tx),after=await read(tx,ctx);if(!same(after.policy,content.desired)||saved.revision!==after.revision||after.revision===s.revision)return fail();}
 finally{await tx.execute(sql`rollback to savepoint people_general_policy_native_preview`);await tx.execute(sql`release savepoint people_general_policy_native_preview`);}
 if(!same(await read(tx,ctx),s))return fail();
 const review=Review.parse({tenantId:s.tenantId,tenantName:s.tenantName,before:s.policy,after:content.desired,scope:'entire_current_organisation'});
 return{content,review,nativeBefore:s,reviewedDigest:createHash('sha256').update(JSON.stringify([1,ctx.tenantId,ctx.userId??null,ctx.personId??null,content,s])).digest('hex')};
}
export async function confirmPeopleGeneralPolicyTx(tx:Tx,ctx:SessionContext,value:unknown,confirmation:unknown){
 const expected=Confirmation.parse(structuredClone(confirmation)),current=await preparePeopleGeneralPolicyTx(tx,ctx,value);if(current.reviewedDigest!==expected.reviewedDigest)return fail();
 if(!same(await read(tx,ctx),current.nativeBefore))return fail();
 // Pass the reviewed logical revision, including NULL, to the SAME native setter.
 const saved=await savePeopleGeneralObservedTx(ctx,{...current.content.desired,revision:current.nativeBefore.revision},tx),effect=Observation.parse(saved.effect),after=await read(tx,ctx);
 if(effect.tenantId!==ctx.tenantId||effect.userId!==ctx.userId||effect.beforeRevision!==current.nativeBefore.revision||effect.revision!==saved.revision||effect.revision!==after.revision||!same(effect.before,current.nativeBefore.policy)||!same(effect.after,current.content.desired)||!same(after.policy,current.content.desired)||effect.insertedPolicy!==(current.nativeBefore.revision===null))return fail();
 return{receipt:Receipt.parse({kind:'recorded',tenantId:ctx.tenantId,policy:after.policy,eventId:effect.eventId,semantics:'native_people_general_policy_current_record'}),nativeRevision:effect.revision,insertedPolicy:effect.insertedPolicy};
}
