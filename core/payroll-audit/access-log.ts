/** AI v2 P2-2b — who viewed or exported payroll data, and who opened their own payslip.
 *
 * The owner of the audit trail already exists: the append-only domain_event log (db/events.ts appendEvent), inside the tenant
 * audit hash chain when it is armed. So an access log entry is one event, not a table of its own:
 *  - `payroll-data.accessed`: an administrator viewed the payroll register of a run or a payslip, or exported payroll data
 *    (a run's transaction report, a payslip PDF, a transaction view, the payment summary, a bank file, a statutory file, the
 *    audit pack). It names the surface, the company, the pay month and run where known, the format, and for a file its sha256,
 *    size and row count. It never carries a figure, a name or a bank or identity number. No employment subject: only
 *    administrators read it.
 *  - `payslip.opened`: an employee opened one of their own released payslips. Subject: that employment (they may read it).
 * Fail closed: a view or an export whose entry cannot be written does not proceed. One exception, stated rather than hidden:
 * a tenant out of good standing gets read-only transactions (ADR-0077 slice 9: read and export, never a lock-out on payroll),
 * so there the entry cannot be written and the read proceeds unrecorded; the result says so. */
import {createHash} from 'node:crypto';
import {sql} from 'drizzle-orm';
import {z} from 'zod';
import {withTenant,type SessionContext,type Tx} from '../../db/client';
import {actorOf,appendEvent} from '../../db/events';
import {TENANT_STATUS_GOOD_STANDING} from '../entitlement-types';
import {PAYROLL_ACCESS_EVENT,PAYROLL_ACCESS_SURFACES,PAYSLIP_OPENED_EVENT,type PayrollAccessSurface} from './types';

const uuid=z.guid();
export const PayrollAccessEntrySchema=z.object({
 surface:z.enum(PAYROLL_ACCESS_SURFACES),
 action:z.enum(['view','export']),
 companyId:uuid,
 payPeriod:z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/).optional(),
 batchId:uuid.optional(),
 payslipId:uuid.optional(),
 /** The employment whose payslip an administrator viewed; recorded in the payload, never as the event's subject. */
 employmentId:uuid.optional(),
 format:z.string().regex(/^[a-z0-9._-]{1,40}$/).optional(),
 fileSha256:z.string().regex(/^[0-9a-f]{64}$/).optional(),
 bytes:z.number().int().nonnegative().optional(),
 rows:z.number().int().nonnegative().optional(),
 /** A closed key a surface adds (a report or file type such as `my.cp39-file`); never free text. */
 detail:z.string().regex(/^[a-z0-9._:-]{1,80}$/).optional(),
}).strict();
export type PayrollAccessEntry=z.infer<typeof PayrollAccessEntrySchema>;
/** `no_login`: a context with no signed-in person (a script or a fixture); no page or route serves one, and there is nobody to
 * name. An agent context is refused outright: the agent principal never reads payroll data through these surfaces. */
export type AccessRecord=Readonly<{recorded:true;eventId:string}>|Readonly<{recorded:false;reason:'read_only_tenant'|'no_login'}>;


export const sha256Hex=(bytes:Uint8Array|string)=>createHash('sha256').update(bytes).digest('hex');
const readOnly=(ctx:SessionContext)=>{const status=ctx.entitlements?.tenantStatus;return status!=null&&!TENANT_STATUS_GOOD_STANDING.has(status)&&!ctx.statutoryOverride;};
const unrecorded=(ctx:SessionContext):AccessRecord|null=>{
 if(ctx.agent)throw new Error('Payroll access is recorded for a signed-in person only.');
 if(!ctx.userId)return Object.freeze({recorded:false as const,reason:'no_login' as const});
 if(readOnly(ctx))return Object.freeze({recorded:false as const,reason:'read_only_tenant' as const});
 return null;
};

export async function recordPayrollAccessTx(tx:Tx,ctx:SessionContext,entry:PayrollAccessEntry):Promise<string>{
 const parsed=PayrollAccessEntrySchema.parse(entry);
 return appendEvent(tx,{tenantId:ctx.tenantId,aggregateType:'payroll-access',aggregateId:parsed.batchId??parsed.companyId,eventType:PAYROLL_ACCESS_EVENT,
  actor:actorOf(ctx),payload:parsed},{returnId:true});
}

/** Records one view or export by the signed-in person. Throws (and so stops the read) when it cannot be written. */
export async function recordPayrollAccess(ctx:SessionContext,entry:PayrollAccessEntry):Promise<AccessRecord>{
 const parsed=PayrollAccessEntrySchema.parse(entry);
 const skipped=unrecorded(ctx);if(skipped)return skipped;
 const eventId=await withTenant(ctx,tx=>recordPayrollAccessTx(tx,ctx,parsed));
 return Object.freeze({recorded:true as const,eventId});
}

/** The same, for a file handed over: its sha256, size and row count go with the entry. */
export function recordPayrollExport(ctx:SessionContext,entry:Omit<PayrollAccessEntry,'action'|'fileSha256'|'bytes'>&{surface:PayrollAccessSurface},
 file:Uint8Array|string,rows?:number):Promise<AccessRecord>{
 const bytes=typeof file==='string'?new TextEncoder().encode(file):file;
 return recordPayrollAccess(ctx,{...entry,action:'export',fileSha256:sha256Hex(bytes),bytes:bytes.byteLength,...(rows===undefined?{}:{rows})});
}

/** An employee opened one of their own released payslips. Only their own: the payslip is read under their row-level security
 * and must belong to an employment of theirs. */
export async function recordPayslipOpened(ctx:SessionContext,input:Readonly<{payslipId:string;channel?:'web'|'mobile'|'pdf'}>):Promise<AccessRecord|null>{
 if(!ctx.userId||ctx.agent||!uuid.safeParse(input.payslipId).success)return null;
 if(readOnly(ctx))return Object.freeze({recorded:false as const,reason:'read_only_tenant' as const});
 return withTenant(ctx,async tx=>{
  const [slip]=await tx.execute(sql`select s.id,s.batch_id,s.employment_id,b.company_id,b.pay_period from public.payslip s
   join public.payroll_batch b on b.id=s.batch_id join public.employment e on e.id=s.employment_id
   where s.id=${input.payslipId}::uuid and b.released_at is not null and b.released_at<=now() and app.is_self_person(e.person_id) limit 1`) as unknown as
   {id:string;batch_id:string;employment_id:string;company_id:string;pay_period:string}[];
  if(!slip)return null;
  const eventId=await appendEvent(tx,{tenantId:ctx.tenantId,aggregateType:'payslip',aggregateId:slip.id,eventType:PAYSLIP_OPENED_EVENT,actor:actorOf(ctx),
   subjectEmploymentId:slip.employment_id,payload:{batchId:slip.batch_id,companyId:slip.company_id,payPeriod:slip.pay_period,channel:input.channel??'web'}},{returnId:true});
  return Object.freeze({recorded:true as const,eventId});
 });
}

/** An export that spans several companies (a transaction view, a history workbook): one entry per company in it, written
 * together. `payPeriod` only when the export is for one month. */
export async function recordPayrollExportAcross(ctx:SessionContext,entry:Readonly<{surface:PayrollAccessSurface;companyIds:readonly string[];payPeriod?:string;
 format?:string;detail?:string}>,file:Uint8Array|string,rows?:number):Promise<AccessRecord>{
 const skipped=unrecorded(ctx);if(skipped)return skipped;
 const bytes=typeof file==='string'?new TextEncoder().encode(file):file,fileSha256=sha256Hex(bytes);
 const ids=[...new Set(entry.companyIds)];
 if(!ids.length)throw new Error('A payroll export names at least one company.');
 const eventIds=await withTenant(ctx,async tx=>{
  const out:string[]=[];
  for(const companyId of ids)out.push(await recordPayrollAccessTx(tx,ctx,{surface:entry.surface,action:'export',companyId,
   ...(entry.payPeriod?{payPeriod:entry.payPeriod}:{}),...(entry.format?{format:entry.format}:{}),...(entry.detail?{detail:entry.detail}:{}),
   fileSha256,bytes:bytes.byteLength,...(rows===undefined?{}:{rows})}));
  return out;
 });
 return Object.freeze({recorded:true as const,eventId:eventIds[0]!});
}

/** An export of one run, named by the run alone (the payment summary): its company and month are read from the run, under
 * the caller's row-level security. Throws when the run is not visible, so nothing unrecorded is handed over. */
export async function recordPayrollExportForBatch(ctx:SessionContext,entry:Readonly<{surface:PayrollAccessSurface;batchId:string;format?:string;detail?:string}>,
 file:Uint8Array|string,rows?:number):Promise<AccessRecord>{
 const skipped=unrecorded(ctx);if(skipped)return skipped;
 const bytes=typeof file==='string'?new TextEncoder().encode(file):file;
 const eventId=await withTenant(ctx,async tx=>{
  const [run]=await tx.execute(sql`select company_id,pay_period from public.payroll_batch where id=${entry.batchId}::uuid and tenant_id=${ctx.tenantId}::uuid`) as unknown as
   {company_id:string;pay_period:string}[];
  if(!run)throw new Error('The run of this export is not visible.');
  return recordPayrollAccessTx(tx,ctx,{surface:entry.surface,action:'export',companyId:run.company_id,payPeriod:run.pay_period,batchId:entry.batchId,
   ...(entry.format?{format:entry.format}:{}),...(entry.detail?{detail:entry.detail}:{}),fileSha256:sha256Hex(bytes),bytes:bytes.byteLength,
   ...(rows===undefined?{}:{rows})});
 });
 return Object.freeze({recorded:true as const,eventId});
}
