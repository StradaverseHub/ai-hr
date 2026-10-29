/** Historical display resolution: a stored null is meaningful and must not fall back to corrected master data. */
import {sql,type SQL} from 'drizzle-orm';
import {informationPayslipSnapshot,payslip,employment,domainEvent} from '../db/schema';
export function frozenPayslipInformation(field:'grade'|'employmentType',fallback:SQL){
 return sql<string|null>`case when exists(select 1 from ${informationPayslipSnapshot} f where f.payslip_id=${payslip.id}) then (select ${field==='grade'?sql`f.grade`:sql`f.employment_type`} from ${informationPayslipSnapshot} f where f.payslip_id=${payslip.id}) else ${fallback}::text end`;
}
/** Before-images are used only before the correction's business day. Earliest later correction wins. */
export function employmentInformationAt<F extends 'hiredOn'|'joinDate'|'companyId'>(field:F,asOf:SQL,fallback:SQL):SQL<F extends 'joinDate'?string|null:string>{
 return sql<F extends 'joinDate'?string|null:string>`case when exists(select 1 from ${domainEvent} ev where ev.tenant_id=app.current_tenant_id() and ev.subject_employment_id=${employment.id} and ev.event_type='employment.information.corrected' and ev.payload->>'effectiveOn'>${asOf}::text) then (select ev.payload->'before'->>${field} from ${domainEvent} ev where ev.tenant_id=app.current_tenant_id() and ev.subject_employment_id=${employment.id} and ev.event_type='employment.information.corrected' and ev.payload->>'effectiveOn'>${asOf}::text order by ev.sequence limit 1) else ${fallback}::text end`;
}
