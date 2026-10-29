/** Historical display resolution: a stored null is meaningful and must not fall back to corrected master data. */
import {sql,getTableColumns,type SQL} from 'drizzle-orm';
import {informationPayslipSnapshot,payslip,payrollBatch,employment,domainEvent} from '../db/schema';
export function frozenPayslipInformation(field:'grade'|'employmentType',fallback:SQL){
 return sql<string|null>`case when exists(select 1 from ${informationPayslipSnapshot} f where f.payslip_id=${payslip.id}) then (select ${field==='grade'?sql`f.grade`:sql`f.employment_type`} from ${informationPayslipSnapshot} f where f.payslip_id=${payslip.id}) else ${fallback}::text end`;
}
/** Before-images are used only before the correction's business day. Earliest later correction wins. */
export function employmentInformationAt<F extends 'hiredOn'|'joinDate'|'companyId'>(field:F,asOf:SQL,fallback:SQL):SQL<F extends 'joinDate'?string|null:string>{
 return sql<F extends 'joinDate'?string|null:string>`case when exists(select 1 from ${domainEvent} ev where ev.tenant_id=app.current_tenant_id() and ev.subject_employment_id=${employment.id} and ev.event_type='employment.information.corrected' and ev.payload->>'effectiveOn'>${asOf}::text) then (select ev.payload->'before'->>${field} from ${domainEvent} ev where ev.tenant_id=app.current_tenant_id() and ev.subject_employment_id=${employment.id} and ev.event_type='employment.information.corrected' and ev.payload->>'effectiveOn'>${asOf}::text order by ev.sequence limit 1) else ${fallback}::text end`;
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
export async function informationPayslipDocuments(tx:Tx,p:{companyIds:string[];year?:number;month?:number;cycle?:string;employmentId?:string;intendedCycle?:boolean}):Promise<HistoricalDocument[]>{
 const documents:HistoricalDocument[]=[],companies=[...new Set(p.companyIds)];
 for(let offset=0;offset<companies.length;offset+=100){
  const rows=await tx.execute<{document:HistoricalDocument}>(sql`select document from app.information_payslip_documents(array[${sql.join(companies.slice(offset,offset+100).map(id=>sql`${id}::uuid`),sql`, `)}]::uuid[],${p.year??null}::integer,${p.month??null}::integer,${p.cycle??null}::text,${p.employmentId??null}::uuid,${p.intendedCycle??false}::boolean) as document`);
  documents.push(...rows.map(r=>r.document));
  if(documents.length>5000)throw new Error('Narrow the payroll period to view retained documents.');
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
