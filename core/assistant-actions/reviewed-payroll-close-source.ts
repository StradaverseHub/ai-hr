/** Human-reviewed Payroll CLOSE specialist. Human custody/POST must own ONE top-level Tx. Canonical
 * checks/effects are shared with ordinary closeBatch. No model money, process, approval or transfer. */
import {z} from 'zod';
import type {SessionContext,Tx} from '../../db/client';
import {withAgentActionGuard} from './agent-action-guard';
import {assertModuleEnabled} from '../entitlements';
import {prepareReviewedPayrollCloseTx,closeReviewedPayrollBatchTx,readReviewedPayrollCloseReferenceTx,withReviewedPayrollCloseIntervalTx as withNativeCloseIntervalTx} from '../../packs/payroll/service';
import {ReviewedPayrollCloseHumanContent as Human,ReviewedPayrollCloseConfirmation as Confirmation,ReviewedPayrollClosePreparedSource as Prepared,ReviewedPayrollCloseSourceReceipt as Receipt} from '../../lib/assistant-actions/reviewed-payroll-close-contract';
export class ReviewedPayrollCloseUnavailable extends Error{constructor(){super('That payroll close needs a final look. Please reopen the processed run.');this.name='ReviewedPayrollCloseUnavailable';}}
const capture=(ctx:SessionContext):SessionContext=>({...ctx,roles:ctx.roles?.slice(),grants:ctx.grants?.map(g=>({...g}))});
export async function assertReviewedPayrollCloseActorTx(tx:Tx,supplied:SessionContext){const fresh=await withAgentActionGuard(tx,capture(supplied),'payroll.close','approve');assertModuleEnabled(fresh,'payroll');return fresh;}
/** Actual native ownership prefix, not a source factory selected by any posted service name. */
export async function withReviewedPayrollCloseSourceIntervalTx<T>(tx:Tx,supplied:SessionContext,batchId:string,run:(ctx:SessionContext,source:{batchId:string;companyId:string;payPeriodId:string;payPeriod:string})=>Promise<T>):Promise<T>{
 const fresh=await assertReviewedPayrollCloseActorTx(tx,supplied);return withNativeCloseIntervalTx(tx,fresh,batchId,(ctx,source)=>run(ctx,{batchId:source.id,companyId:source.companyId,payPeriodId:source.payPeriodId,payPeriod:source.payPeriod}));
}
const receipt=(native:NonNullable<Awaited<ReturnType<typeof readReviewedPayrollCloseReferenceTx>>>,replayed:boolean)=>Receipt.parse({kind:'closed',...native,proof:'historical_close_current_batch',semantics:'configured_payslip_release_not_bank_payment',replayed});
export async function prepareReviewedPayrollCloseSourceTx(tx:Tx,supplied:SessionContext,value:unknown):Promise<z.infer<typeof Prepared>>{
 const ctx=capture(supplied);try{const content=Human.parse(structuredClone(value)),fresh=await assertReviewedPayrollCloseActorTx(tx,ctx),native=await prepareReviewedPayrollCloseTx(tx,fresh,content.batchId);return Prepared.parse({kind:'prepared_source',content,review:native.review,reviewedDigest:native.reviewedDigest,erasurePersonIds:native.erasurePersonIds,erasureSource:native.erasureSource,consequence:'immutable_run_configured_payslip_release_not_bank_payment'});}catch{throw new ReviewedPayrollCloseUnavailable();}
}
/** Any failure rolls back batch/period status, configured release and all native audit effects. */
export async function confirmReviewedPayrollCloseSourceTx(tx:Tx,supplied:SessionContext,storedHumanValue:unknown,confirmationValue:unknown):Promise<z.infer<typeof Receipt>>{
 const ctx=capture(supplied);try{const content=Human.parse(structuredClone(storedHumanValue)),expected=Confirmation.parse(structuredClone(confirmationValue)),fresh=await assertReviewedPayrollCloseActorTx(tx,ctx),native=await closeReviewedPayrollBatchTx(tx,fresh,content.batchId,expected.reviewedDigest);return receipt(native,false);}catch{throw new ReviewedPayrollCloseUnavailable();}
}
/** A completed retry rereads the exact original actor event/current native state, never recloses. */
export async function reconcileReviewedPayrollCloseSourceTx(tx:Tx,supplied:SessionContext,value:unknown):Promise<z.infer<typeof Receipt>>{
 const ctx=capture(supplied);try{const reference=z.union([Receipt.pick({batchId:true,closedEventId:true}).strict(),Receipt]).parse(structuredClone(value)),fresh=await assertReviewedPayrollCloseActorTx(tx,ctx),native=await readReviewedPayrollCloseReferenceTx(tx,fresh,reference);if(!native)throw new ReviewedPayrollCloseUnavailable();return receipt(native,true);}catch{throw new ReviewedPayrollCloseUnavailable();}
}
