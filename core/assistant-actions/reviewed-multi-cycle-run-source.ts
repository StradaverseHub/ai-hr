/** Human-reviewed additional-run CREATE source. Persistent action custody must serialize NEW creation
 * and own the top-level Tx before human POST/UI exposure. Direct repeated source calls may create
 * additional native drafts; this layer does not invent an idempotency/execution ledger.
 * No money, payroll processing/closing, employee pay preview, payslip or payment is performed. */
import {z} from 'zod';
import type {SessionContext,Tx} from '../../db/client';
import {withAgentActionGuard} from './agent-action-guard';
import {assertModuleEnabled} from '../entitlements';
import {prepareReviewedAdditionalRunTx,createReviewedAdditionalRunTx,readReviewedAdditionalRunReferenceTx,withReviewedAdditionalRunIntervalTx} from '../../packs/payroll/service';
import {ReviewedMultiCycleRunHumanContent as Human,ReviewedMultiCycleRunConfirmation as Confirmation,ReviewedMultiCycleRunPreparedSource as Prepared,ReviewedMultiCycleRunSourceReceipt as Receipt} from '../../lib/assistant-actions/reviewed-multi-cycle-run-contract';
export class ReviewedMultiCycleRunUnavailable extends Error{constructor(){super('That payroll draft needs another look. Please reopen Payroll Process.');this.name='ReviewedMultiCycleRunUnavailable';}}
const capture=(ctx:SessionContext):SessionContext=>({...ctx,roles:ctx.roles?.slice(),grants:ctx.grants?.map(g=>({...g}))});
export async function assertReviewedMultiCycleRunActorTx(tx:Tx,supplied:SessionContext){const fresh=await withAgentActionGuard(tx,capture(supplied),'multi_cycle_payroll.create_run','approve');assertModuleEnabled(fresh,'payroll');return fresh;}
export async function withReviewedMultiCycleRunSourceIntervalTx<T>(tx:Tx,supplied:SessionContext,selection:{companyId:string;payPeriod:string;payrollCycleId:string},run:(ctx:SessionContext,source:{companyId:string;payPeriod:string;payrollCycleId:string})=>Promise<T>):Promise<T>{const fresh=await assertReviewedMultiCycleRunActorTx(tx,supplied);return withReviewedAdditionalRunIntervalTx(tx,fresh,selection,run);}
const receipt=(native:NonNullable<Awaited<ReturnType<typeof readReviewedAdditionalRunReferenceTx>>>,replayed:boolean)=>Receipt.parse({kind:'created',...native,proof:'historical_create_current_run',semantics:'draft_created_not_processed_closed_paid_or_payslip',replayed});
export async function prepareReviewedMultiCycleRunSourceTx(tx:Tx,supplied:SessionContext,value:unknown):Promise<z.infer<typeof Prepared>>{
 const ctx=capture(supplied);try{const content=Human.parse(structuredClone(value)),fresh=await assertReviewedMultiCycleRunActorTx(tx,ctx),native=await prepareReviewedAdditionalRunTx(tx,fresh,content.input);return Prepared.parse({kind:'prepared_source',content,review:native.review,reviewedDigest:native.reviewedDigest,erasurePersonIds:native.erasurePersonIds,erasureEmploymentIds:native.erasureEmploymentIds});}catch{throw new ReviewedMultiCycleRunUnavailable();}
}
/** Fresh exact native source is matched BEFORE effect; ALL failures require whole caller rollback. */
export async function confirmReviewedMultiCycleRunSourceTx(tx:Tx,supplied:SessionContext,storedHumanValue:unknown,confirmationValue:unknown):Promise<z.infer<typeof Receipt>>{
 const ctx=capture(supplied);try{const content=Human.parse(structuredClone(storedHumanValue)),expected=Confirmation.parse(structuredClone(confirmationValue)),fresh=await assertReviewedMultiCycleRunActorTx(tx,ctx),native=await createReviewedAdditionalRunTx(tx,fresh,content.input,expected.reviewedDigest);return receipt(native,false);}catch{throw new ReviewedMultiCycleRunUnavailable();}
}
/** Exact original-actor event/current company-month authority only; never create again. */
export async function reconcileReviewedMultiCycleRunSourceTx(tx:Tx,supplied:SessionContext,value:unknown):Promise<z.infer<typeof Receipt>>{
 const ctx=capture(supplied);try{const reference=z.union([Receipt.pick({batchId:true,createdEventId:true}).strict(),Receipt]).parse(structuredClone(value)),fresh=await assertReviewedMultiCycleRunActorTx(tx,ctx),native=await readReviewedAdditionalRunReferenceTx(tx,fresh,reference);if(!native)throw new ReviewedMultiCycleRunUnavailable();return receipt(native,true);}catch{throw new ReviewedMultiCycleRunUnavailable();}
}
