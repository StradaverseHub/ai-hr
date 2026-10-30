/** Human-reviewed authorised Workforce action. The HR principal stays distinct from the target employee.
 * A governed non-own-subject custody binding/human POST is still required; the existing own-person
 * review table must not be reused by impersonating this subordinate. No all-tenant graph is returned. */
import {z} from 'zod';
import type {SessionContext,Tx} from '../../db/client';
import {withAgentActionGuard} from './agent-action-guard';
import {prepareReviewedReportingLineTx,setReviewedReportingLineTx,readReviewedReportingLineReferenceTx} from '../workforce-commands';
import {ReviewedReportingLineHumanContent as Human,ReviewedReportingLineConfirmation as Confirmation,ReviewedReportingLinePreparedSource as Prepared,ReviewedReportingLineSourceReceipt as Receipt} from '../../lib/assistant-actions/reviewed-reporting-line-contract';
export class ReviewedReportingLineUnavailable extends Error{constructor(){super('That reporting change needs another look. Please use the employee record.');this.name='ReviewedReportingLineUnavailable';}}
const capture=(ctx:SessionContext):SessionContext=>({...ctx,roles:ctx.roles?.slice(),grants:ctx.grants?.map(g=>({...g}))});
async function actor(tx:Tx,ctx:SessionContext){return withAgentActionGuard(tx,ctx,'org.reporting.change','approve');}
const selection=(human:z.infer<typeof Human>)=>({subordinateEmploymentId:human.subordinateEmploymentId,managerEmploymentId:human.managerEmploymentId,lineType:human.lineType,validFrom:human.validFrom});
export async function prepareReviewedReportingLineSourceTx(tx:Tx,supplied:SessionContext,value:unknown):Promise<z.infer<typeof Prepared>>{
 const ctx=capture(supplied);try{const content=Human.parse(structuredClone(value)),fresh=await actor(tx,ctx),native=await prepareReviewedReportingLineTx(tx,fresh,selection(content)),{reviewedDigest,...review}=native;return Prepared.parse({kind:'prepared_source',content,review,reviewedDigest,consequence:'structural_reporting_change_not_delegation'});}catch{throw new ReviewedReportingLineUnavailable();}
}
/** Refusal rolls the WHOLE command back, including prior closure and both native event effects. */
export async function confirmReviewedReportingLineSourceTx(tx:Tx,supplied:SessionContext,storedHumanValue:unknown,confirmationValue:unknown):Promise<z.infer<typeof Receipt>>{
 const ctx=capture(supplied);try{const content=Human.parse(structuredClone(storedHumanValue)),expected=Confirmation.parse(structuredClone(confirmationValue)),fresh=await actor(tx,ctx),native=await setReviewedReportingLineTx(tx,fresh,selection(content),expected.reviewedDigest);return Receipt.parse({kind:'recorded',...native,semantics:'recorded_reporting_line_current_record',replayed:false});}catch{throw new ReviewedReportingLineUnavailable();}
}
export async function reconcileReviewedReportingLineSourceTx(tx:Tx,supplied:SessionContext,value:unknown):Promise<z.infer<typeof Receipt>>{
 const ctx=capture(supplied);try{const reference=z.union([Receipt.pick({reportingLineId:true,setEventId:true,subordinateEmploymentId:true}).strict(),Receipt]).parse(structuredClone(value)),fresh=await actor(tx,ctx),native=await readReviewedReportingLineReferenceTx(tx,fresh,reference);if(!native)throw new ReviewedReportingLineUnavailable();return Receipt.parse({kind:'recorded',...native,semantics:'recorded_reporting_line_current_record',replayed:true});}catch{throw new ReviewedReportingLineUnavailable();}
}
