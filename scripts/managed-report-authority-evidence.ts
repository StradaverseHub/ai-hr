/** Controlled fixture boundary only: not a paused sender or an alternate delivery implementation. */
import type {ReportBrokerRequest} from '../lib/internal-auth/report-broker-model';
export type ManagedReportAuthorityProof={request:Extract<ReportBrokerRequest,{phase:'start'}>;validUntil:number};
export type ManagedReportAuthorityEvidence={
 prepare():Promise<ManagedReportAuthorityProof>;
 change(validUntil:number):Promise<void>;
 liveLease():Promise<void>;
 start(request:ManagedReportAuthorityProof['request']):Promise<unknown>;
 deliver():Promise<{outcome?:string}>;
 finishSkipped():Promise<void>;
 outcome():Promise<{status:string;reason:string|null}>;
 smtpCount():number;
 now():number;
};
function requireEvidence(value:unknown):asserts value{if(!value)throw new Error('After-generation authority refusal was not proven.');}
export async function assertManagedReportAuthorityRefusal(d:ManagedReportAuthorityEvidence){
 const proof=await d.prepare();await d.change(proof.validUntil);const before=d.smtpCount();await d.liveLease();
 const result=await d.deliver(),row=await d.outcome();
 requireEvidence(result.outcome==='skipped'&&row.status==='skipped'&&row.reason==='notEligible'&&d.smtpCount()===before);
}
