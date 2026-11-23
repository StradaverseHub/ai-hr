/** One set-based read of the accepted-TP3 opening inputs for a recalculation selection (board item 0af23331, ADR-0167
 * 23 November 2026). No per-employee statement (SCALE rule 2). Access is decided per row from the caller's own visibility of
 * the person, the employment and the employer's payroll; TP3 rows are joined only where that holds, so a hidden TP3 is
 * reported as insufficient access, never as absence. employee_tp3_draft is never read. */
import {sql} from 'drizzle-orm';
import type {SessionContext,Tx} from '../db/client';
import type {Tp3Payload} from '../db/schema';
import {deriveAccumulatorSeed} from './tp3';
import {resolveTp3Opening,type TaxOpeningRow,type Tp3OpeningResolution} from '../lib/payroll-tax-opening-tp3';

const uuidArray=(ids:string[])=>sql`array[${sql.join(ids.map(id=>sql`${id}::uuid`),sql`, `)}]::uuid[]`;

export async function readTaxOpeningRowsTx(tx:Tx,ctx:SessionContext,year:number,employmentIds:readonly string[]):Promise<Map<string,TaxOpeningRow>>{
 const ids=[...new Set(employmentIds)];
 if(!ids.length)return new Map();
 const rows=await tx.execute<TaxOpeningRow>(sql`
  with subject as materialized (
   select e.id,e.tenant_id,e.person_id,
    (app.can_see_person(e.person_id) is true and app.can_admin_payroll_for(e.company_id) is true
     and app.can_admin_employment(e.id) is true) as access
   from employment e
   where e.tenant_id=${ctx.tenantId}::uuid and e.id=any(${uuidArray(ids)})
  )
  select s.id,s.access,
   t.id as "tp3Id",case when t.id is null then null else t.xmin::text||':'||t.updated_at::text end as "tp3Revision",t.payload as "tp3Payload",
   (m.person_id is not null) as projection,m.tp3_exemption_used as "projectionUsed",
   case when m.person_id is null then null else m.xmin::text end as "projectionRevision",
   a.had_previous_employer as declared,a.id as "answerId"
  from subject s
  left join employee_tp3 t on s.access and t.tenant_id=s.tenant_id and t.person_id=s.person_id and t.assessment_year=${year}
  left join employee_statutory_my m on s.access and m.tenant_id=s.tenant_id and m.person_id=s.person_id and m.tp3_year=${year}
  left join lateral (
   select a.id,a.had_previous_employer from payroll_tp3_previous_employer_answer a
   where s.access and a.tenant_id=s.tenant_id and a.employment_id=s.id and a.person_id=s.person_id and a.assessment_year=${year}
   order by a.answered_at desc,a.id desc limit 1
  ) a on true
  order by s.id`);
 return new Map(rows.map(row=>[row.id,row]));
}

/** The canonical per-code mapping live payroll's TP3 projection is derived from (core/tp3.ts deriveAccumulatorSeed). */
export function formExemptionUsed(payload:unknown):Record<string,number>|null{
 return deriveAccumulatorSeed(payload as Tp3Payload)?.exemptionUsed??null;
}

export function resolveTaxOpeningRow(row:TaxOpeningRow|undefined):Tp3OpeningResolution{
 return resolveTp3Opening(row,formExemptionUsed);
}
