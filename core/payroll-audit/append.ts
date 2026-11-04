/** AI v2 P2-2b — the one writer of payroll_audit_capture (migration 0965), kept a leaf so the payroll processing owner can
 * call it inside its own transaction without importing the payroll facade back.
 *
 * Each artefact is inserted unless its content equals the LATEST capture of the same source key (Phase 2 hardening: a
 * version that changes and then changes back is captured again, so a revert to an earlier version is never hidden). The
 * database decides that, under the company and month lock, and computes the content hash, the sequence and the link to the
 * previous capture of the company and month, and anchors the row in the tenant audit hash chain (migration 2006). A capture
 * is never updated or deleted. */
import {createHash} from 'node:crypto';
import type {Tx} from '../../db/client';
import {payrollAuditCapture} from '../../db/payroll-audit-schema';
import type {AuditCaptureKind} from './types';

export type AuditArtefact=Readonly<{kind:AuditCaptureKind;sourceKey:string;batchId:string|null;content:Record<string,unknown>}>;
export type CaptureWriter=Readonly<{kind:'agent';principalId:string;runId:string}>|Readonly<{kind:'user';userId:string}>;

/** The largest artefact kept whole (migration 0965 bounds a capture at 1 MiB of canonical text). A larger one, such as the
 * processing event of a very large run, is kept as its own sha256 and size, so the capture still proves what it was. */
const MAX_CONTENT_CHARS=700_000;
const bounded=(content:Record<string,unknown>):Record<string,unknown>=>{
 const text=JSON.stringify(content);
 return text.length<=MAX_CONTENT_CHARS?content:{oversize:true,sha256:createHash('sha256').update(text).digest('hex'),chars:text.length};
};

/** Appends the artefacts that are new or changed since their latest capture. Returns how many were captured (the trigger
 * skips an unchanged one, so it is not returned). */
export async function appendCapturesTx(tx:Tx,tenantId:string,writer:CaptureWriter,p:Readonly<{companyId:string;payPeriod:string}>,artefacts:readonly AuditArtefact[]):Promise<number>{
 let captured=0;
 for(let offset=0;offset<artefacts.length;offset+=100){
  const chunk=artefacts.slice(offset,offset+100);
  const inserted=await tx.insert(payrollAuditCapture).values(chunk.map(item=>({tenantId,companyId:p.companyId,payPeriod:p.payPeriod,batchId:item.batchId,kind:item.kind,
   sourceKey:item.sourceKey,content:bounded(item.content),writer:writer.kind,writerId:writer.kind==='agent'?writer.principalId:writer.userId,
   runId:writer.kind==='agent'?writer.runId:null}))).onConflictDoNothing().returning({id:payrollAuditCapture.id});
  captured+=inserted.length;
 }
 return captured;
}
