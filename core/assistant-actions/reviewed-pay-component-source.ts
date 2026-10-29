/** Human-reviewed tenant-catalogue specialist. Human review/custody/POST must own the top-level Tx.
 * No model calculation, statutory classification guess, employee assignment or payroll effect. */
import {z} from 'zod';
import {sql} from 'drizzle-orm';
import {lockPayComponentCatalogTx} from '../pay-component-catalog-lock';
import type {SessionContext,Tx} from '../../db/client';
import {withAgentActionGuard} from './agent-action-guard';
import {assertModuleEnabled} from '../entitlements';
import {prepareReviewedPayComponentCreateTx,createReviewedPayComponentTx,readReviewedPayComponentReferenceTx} from '../../packs/payroll/service';
import {ReviewedPayComponentHumanContent as Human,ReviewedPayComponentConfirmation as Confirmation,ReviewedPayComponentPreparedSource as Prepared,ReviewedPayComponentSourceReceipt as Receipt} from '../../lib/assistant-actions/reviewed-pay-component-contract';
export class ReviewedPayComponentUnavailable extends Error{constructor(){super('That pay-code setup needs another look. Please reopen Payroll Setup.');this.name='ReviewedPayComponentUnavailable';}}
const capture=(ctx:SessionContext):SessionContext=>({...ctx,roles:ctx.roles?.slice(),grants:ctx.grants?.map(g=>({...g}))});
async function actor(tx:Tx,ctx:SessionContext){const fresh=await withAgentActionGuard(tx,ctx,'typed_pay_components.create','approve');assertModuleEnabled(fresh,'payroll');return fresh;}
/** Catalogue and fresh native admin ownership precede ANY custody row. The catalogue lock supplies
 * no authority; the exact existing app.is_admin predicate is still required. No source input is posted
 * to this interval and no native catalogue values leave through the callback binding itself. */
export async function withReviewedPayComponentIntervalTx<T>(tx:Tx,supplied:SessionContext,work:(fresh:SessionContext)=>Promise<T>):Promise<T>{
 const fresh=await actor(tx,capture(supplied));await lockPayComponentCatalogTx(tx,fresh,true);
 const [admin]=await tx.execute<{allowed:boolean}>(sql`select app.is_admin() as allowed`);
 if(admin?.allowed!==true)throw new ReviewedPayComponentUnavailable();return work(fresh);
}
const receipt=(row:NonNullable<Awaited<ReturnType<typeof readReviewedPayComponentReferenceTx>>>,replayed:boolean)=>{const {kind,...rest}=row;return Receipt.parse({kind:'created',...rest,kindOfComponent:kind,proof:'historical_create_current_record',replayed});};
export async function prepareReviewedPayComponentSourceTx(tx:Tx,supplied:SessionContext,value:unknown):Promise<z.infer<typeof Prepared>>{
 const ctx=capture(supplied);try{const content=Human.parse(structuredClone(value)),fresh=await actor(tx,ctx),native=await prepareReviewedPayComponentCreateTx(tx,fresh,content.input);return Prepared.parse({kind:'prepared_source',content,review:native.review,reviewedDigest:native.reviewedDigest,consequence:'catalogue_created_no_employee_assignment_or_payroll_run'});}catch{throw new ReviewedPayComponentUnavailable();}
}
/** Refusal requires full caller Tx rollback, including resolution-order updates and native event. */
export async function confirmReviewedPayComponentSourceTx(tx:Tx,supplied:SessionContext,storedHumanValue:unknown,confirmationValue:unknown):Promise<z.infer<typeof Receipt>>{
 const ctx=capture(supplied);try{const content=Human.parse(structuredClone(storedHumanValue)),expected=Confirmation.parse(structuredClone(confirmationValue)),fresh=await actor(tx,ctx),native=await createReviewedPayComponentTx(tx,fresh,content.input,expected.reviewedDigest);return receipt(native,false);}catch{throw new ReviewedPayComponentUnavailable();}
}
export async function reconcileReviewedPayComponentSourceTx(tx:Tx,supplied:SessionContext,value:unknown):Promise<z.infer<typeof Receipt>>{
 const ctx=capture(supplied);try{const reference=z.union([Receipt.pick({componentId:true,createdEventId:true}).strict(),Receipt]).parse(structuredClone(value)),fresh=await actor(tx,ctx),native=await readReviewedPayComponentReferenceTx(tx,fresh,reference);if(!native)throw new ReviewedPayComponentUnavailable();return receipt(native,true);}catch{throw new ReviewedPayComponentUnavailable();}
}
