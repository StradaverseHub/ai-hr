/** Historical display resolution: a stored null is meaningful and must not fall back to corrected master data. */
import {sql,getTableColumns,type SQL} from 'drizzle-orm';
import {informationPayslipSnapshot,payslip,payrollBatch,employment,domainEvent} from '../db/schema';
export function frozenPayslipInformation(field:'grade'|'employmentType',fallback:SQL){
 return sql<string|null>`case when exists(select 1 from ${informationPayslipSnapshot} f where f.payslip_id=${payslip.id}) then (select ${field==='grade'?sql`f.grade`:sql`f.employment_type`} from ${informationPayslipSnapshot} f where f.payslip_id=${payslip.id}) else ${fallback}::text end`;
}
/** Board 4604dccc r4 (ADR 2026-11-15 dated information corrections, revision 4) — the LATEST SAVED correction of a
 * field controls it from its Effective Date onward. The correction in force on `asOf` is the latest saved one (by
 * domain_event.sequence) that changed `field` and is dated on or before `asOf`; nothing saved before it can override
 * it. A before-image is used only before a correction's business day, and only from a correction saved after the one
 * in force (the earliest such one wins); otherwise the fallback (current master data) answers. Corrections saved in
 * Effective Date order give exactly the earlier rule ("earliest later correction wins"): every correction dated after
 * `asOf` was then saved after the one in force. One correlated subquery per field (SCALE rule 2). */
export function employmentInformationAt<F extends 'hiredOn'|'joinDate'|'companyId'>(field:F,asOf:SQL,fallback:SQL):SQL<F extends 'joinDate'?string|null:string>{
 // A correction changed the field when its `fields` list names it; an older payload without the list, when its before
 // and after values differ.
 const changed=sql`(case when jsonb_typeof(l.payload->'fields')='array' then l.payload->'fields' @> jsonb_build_array(${field}::text) else (l.payload->'before'->>${field}) is distinct from (l.payload->'after'->>${field}) end)`;
 const inForce=sql`coalesce((select max(l.sequence) from ${domainEvent} l where l.tenant_id=app.current_tenant_id() and l.subject_employment_id=${employment.id} and l.event_type='employment.information.corrected' and l.payload->>'effectiveOn'<=${asOf}::text and ${changed}),0)`;
 const later=sql`ev.tenant_id=app.current_tenant_id() and ev.subject_employment_id=${employment.id} and ev.event_type='employment.information.corrected' and ev.payload->>'effectiveOn'>${asOf}::text and ev.sequence>${inForce}`;
 return sql<F extends 'joinDate'?string|null:string>`case when exists(select 1 from ${domainEvent} ev where ${later}) then (select ev.payload->'before'->>${field} from ${domainEvent} ev where ${later} order by ev.sequence limit 1) else ${fallback}::text end`;
}

import {QueryBuilder} from 'drizzle-orm/pg-core';
import * as reportSchema from '../db/schema';
import type {Tx} from '../db/client';
import type {PayslipReviewRow} from '../packs/payroll/service';
import type {EmploymentStatus} from './employment-status';
type RunType=PayslipReviewRow['runType'];
/** Only retained document fields can overlay a live transaction. Money and publication stay canonical. */
const profileFields=['employeeName','employee','employeeCode','company','companyReg','currency','cycleName','informationFields','businessUnit','department','position','jobGrade','employmentType','division','branch','region','line','section','team','base','category','paymentMethod','bankName','bankAccountNo','icNumber','passportNumber','epfNumber','socsoNumber','taxNumber','employmentStatus'] as const;
type RawDocumentRow=Omit<PayslipReviewRow,'bankAccountMasked'|'bankAccountFull'|'identityNumber'|'identityIsPassport'> & {bankAccountNo:string|null;icNumber:string|null;passportNumber:string|null;employmentStatus:EmploymentStatus;batchStatus:typeof payrollBatch.$inferSelect.status};
type HistoricalDocument={metadata:Record<string,unknown>;batch:Record<string,unknown>;payslip:Record<string,unknown>};
export function overlayInformationDocument<T extends object>(row:T,document:HistoricalDocument|null):T{
 if(!document)return row;
 const result={...row};for(const key of profileFields)if(key in row&&Object.hasOwn(document.metadata,key))Object.assign(result,{[key]:document.metadata[key]});return result;
}
export async function informationPayslipDocument(tx:Tx,id:string):Promise<HistoricalDocument|null>{
 const [row]=await tx.execute<{document:HistoricalDocument|null}>(sql`select app.information_payslip_document(${id}::uuid) as document`);return row?.document??null;
}
/** Safety ceiling for an UNCAPPED read (exports, one employee's runs). The database function returns at most one row
 * more than this per company chunk. */
export const RETAINED_DOCUMENT_CEILING=5000;
/**
 * `limit` — a capped caller (Transaction View's History landing tab) wants only the newest `limit` documents, the
 * same cap its live rows already have. Each company chunk then returns at most `limit` rows in the function's
 * newest-period-first order, so the union always contains the newest `limit` of the whole scope, and the caller
 * merges, sorts and slices exactly as it does for live rows. A capped read never throws: prod 2026-11-15, "All
 * companies" with no period passed 5,000 retained documents and the landing tab became an error page.
 * Without `limit` the ceiling still refuses rather than silently returning a partial set.
 */
export async function informationPayslipDocuments(tx:Tx,p:{companyIds:string[];year?:number;month?:number;cycle?:string;employmentId?:string;intendedCycle?:boolean;limit?:number}):Promise<HistoricalDocument[]>{
 const documents:HistoricalDocument[]=[],companies=[...new Set(p.companyIds)];
 const limit=Number.isInteger(p.limit)&&p.limit!>0?Math.min(p.limit!,RETAINED_DOCUMENT_CEILING):undefined;
 for(let offset=0;offset<companies.length;offset+=100){
  const rows=await tx.execute<{document:HistoricalDocument}>(sql`select d.document from app.information_payslip_documents(array[${sql.join(companies.slice(offset,offset+100).map(id=>sql`${id}::uuid`),sql`, `)}]::uuid[],${p.year??null}::integer,${p.month??null}::integer,${p.cycle??null}::text,${p.employmentId??null}::uuid,${p.intendedCycle??false}::boolean) with ordinality as d(document,ordinal) order by d.ordinal${limit?sql` limit ${limit}`:sql``}`);
  documents.push(...rows.map(r=>r.document));
  if(!limit&&documents.length>RETAINED_DOCUMENT_CEILING)throw new Error('Narrow the payroll period to view retained documents.');
 }
 return documents;
}
/** Fixed SQL projection supplies exact numeric strings, never JSON numeric conversions. */
export function informationDocumentRow(d:HistoricalDocument):RawDocumentRow{
 const b=d.batch,p=d.payslip;
 return {...d.metadata,id:p.id,employmentId:p.employment_id,companyId:b.company_id,batchId:b.id,payPeriod:b.pay_period,runType:b.run_type as RunType,runSeq:b.run_seq,batchStatus:b.status,
 historyImportAttemptId:b.history_import_attempt_id,historyImportCycleName:b.history_import_cycle_name,releasedAt:b.released_at?new Date(String(b.released_at)):null,version:p.version,
 basic:p.basic_salary,allowance:p.allowance,overtime:p.overtime_pay,bonus:p.bonus,gross:p.gross_pay,statutory:p.statutory,otherDeductions:p.other_deductions,totalDeductions:p.total_deductions,net:p.net_pay,employerCost:p.employer_cost,daysWorked:p.days_worked,coverageFrom:p.coverage_from,coverageTo:p.coverage_to,payDate:b.history_import_attempt_id?null:b.batch_date} as RawDocumentRow;
}

/** Report-only relation. Visible rows retain their ordinary owner; only missing retained rows are added.
 * The database projection exposes prescribed financial-report fields, never a current Workforce row.
 */
export function informationReportRelation<K extends 'employment'|'person'|'employee_statutory_my'|'payslip'|'assignment'|'tp1_relief'|'ea_override'>(kind:K,companyId:string|undefined,period:string){
 const table=sql.raw(kind),key=sql.raw(kind==='employee_statutory_my'?'person_id':'id'),jsonKey=sql.raw(kind==='employee_statutory_my'?"'person_id'":"'id'");
 const relation=sql`(select live.* from ${table} live union all select retained.* from
 (select distinct on (data->>${jsonKey}) data from app.information_report_records(${kind},${companyId??null}::uuid,${period}) with ordinality source(data,source_order) where data->>${jsonKey} is not null order by data->>${jsonKey},source_order) records
 cross join lateral jsonb_populate_record(null::${table},records.data) retained
 where not exists(select 1 from ${table} visible where visible.${key}=retained.${key})) ${table}`;
 const tables={employment:reportSchema.employment,person:reportSchema.person,employee_statutory_my:reportSchema.employeeStatutoryMy,payslip:reportSchema.payslip,assignment:reportSchema.assignment,tp1_relief:reportSchema.tp1Relief,ea_override:reportSchema.eaOverride};
 const fields=Object.fromEntries(Object.entries(getTableColumns(tables[kind])).map(([key,column])=>[key,sql`${column}`.mapWith(column).as(column.name)]));
 return new QueryBuilder().select(fields).from(relation).as(kind);
}
