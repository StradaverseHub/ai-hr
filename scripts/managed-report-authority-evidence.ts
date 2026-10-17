/** Controlled fixture boundary only: not a paused sender or an alternate delivery implementation. */
import type {ReportBrokerRequest} from '../lib/internal-auth/report-broker-model';
import {reportBrokerResponse} from '../lib/internal-auth/report-broker-model';
export type ManagedReportAuthorityProof={request:Extract<ReportBrokerRequest,{phase:'start'}>;validUntil:number};
export type ManagedReportAuthorityEvidence={
 prepare():Promise<ManagedReportAuthorityProof>;
 change(validUntil:number):Promise<void>;
 liveLease():Promise<void>;
 start(request:ManagedReportAuthorityProof['request']):Promise<unknown>;
 finishSkipped():Promise<void>;
 outcome():Promise<{status:string;reason:string|null}>;
 smtpCount():number;
 now():number;
};
function requireEvidence(value:unknown):asserts value{if(!value)throw new Error('After-generation authority refusal was not proven.');}
export async function assertManagedReportAuthorityRefusal(d:ManagedReportAuthorityEvidence){
 const before=d.smtpCount(),proof=await d.prepare();
 requireEvidence(Number.isSafeInteger(proof.validUntil));
 await d.change(proof.validUntil);await d.liveLease();
 // Leave ten seconds for IPC/retirement, then prove the entire call completed before expiry.
 requireEvidence(d.now()<proof.validUntil-10_000);
 const result=reportBrokerResponse.parse(await d.start(proof.request));
 requireEvidence(d.now()<proof.validUntil&&'ok' in result&&!result.ok&&result.reason==='notEligible');
 requireEvidence((await d.outcome()).status==='pending'&&d.smtpCount()===before);
 await d.finishSkipped();const row=await d.outcome();
 requireEvidence(row.status==='skipped'&&row.reason==='notEligible'&&d.smtpCount()===before);
}
