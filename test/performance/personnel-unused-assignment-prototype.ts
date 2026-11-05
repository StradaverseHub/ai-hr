/** Test-only unused LEFT join omission. Eligibility checks the actual composed consumers.
 * No synthetic NULL department/type columns: those columns do not exist in the eligible source.
 * Full selected-row JSON remains the original qualified native owner, including real assignments.
 */
import {PgDialect} from 'drizzle-orm/pg-core';
import {sql} from 'drizzle-orm';
import {expect} from 'vitest';
import {personnelListPageSql} from '../../core/read';
export function personnelUnusedAssignmentFacts(page:Parameters<typeof personnelListPageSql>[0],facets:Parameters<typeof personnelListPageSql>[1],facts:{body:string;owner:string;columns:string[]}){
 const compiled=new PgDialect().sqlToQuery(personnelListPageSql(page,facets,{source:sql`app.access_workforce_list_facts()`,materialized:false,projectPageFacts:true}));
 const pruned=!/\bworkforce_row\.(?:department_id|employment_type)\b/.test(compiled.sql)
  &&(!page.sort||page.sort==='name'||page.sort==='company');
 if(!pruned)return {facts,pruned:false};
 const join=' LEFT JOIN public.assignment a ON a.employment_id=e.id AND a.tenant_id=e.tenant_id AND a.valid_to IS NULL AND a.superseded_at IS NULL';
 const fields='a.department_id,a.employment_type::text,';
 expect(facts.body.split(join)).toHaveLength(2);expect(facts.body.split(fields)).toHaveLength(2);
 const body=facts.body.replace(join,'').replace(fields,'');
 expect(body).not.toMatch(/\ba\./);expect(body).not.toMatch(/NULL::(?:uuid|text)/i);
 const columns=facts.columns.filter(column=>column!=='department_id'&&column!=='employment_type');expect(columns).toHaveLength(facts.columns.length-2);
 return {facts:{...facts,body,columns},pruned:true};
}
