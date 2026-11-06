/** Disposable database only. Batch dated tags without replacing the live projection or its grants. */
import {randomUUID} from 'node:crypto';
import {sql} from 'drizzle-orm';
import {expect} from 'vitest';
import {owner} from '../harness';

const originalTagged = ` tagged AS MATERIALIZED (
   SELECT b.*,app.employment_organisation_tags(b.id,p_as_of) AS tags
   FROM candidates b
 ),`;

// Keep the original owner for any row that cannot take the proven fast path. For other rows,
// reuse canonical dated-company and company-tag resolution, then apply the current classification
// rule from company_org_employment_unchecked. Both date-specific assignment tie-breaks stay intact.
const batchedTagged = ` dated AS MATERIALIZED (
   SELECT b.*,app.company_org_employment_company(b.id,p_as_of) AS dated_company
   FROM candidates b
 ),
 current_principal AS MATERIALIZED (
   SELECT app.principal_snapshot_current() AS allowed
 ),
 company_tags AS MATERIALIZED (
   SELECT pc.id,app.company_org_tags_unchecked(pc.id,p_as_of) AS tags
   FROM permitted_companies pc
   WHERE p_as_of IS NOT NULL AND isfinite(p_as_of)
     AND (SELECT allowed FROM current_principal)
     AND EXISTS (SELECT 1 FROM dated d WHERE d.dated_company=pc.id)
 ),
 tagged AS MATERIALIZED (
   SELECT d.value,d.id,d.tenant_id,d.company_id,d.hired_on,d.grade_id,
          d.confirmation_date,d.final_confirmation_date,
          CASE
            WHEN t.tags->>'companyId' IS DISTINCT FROM d.dated_company::text OR t.tags IS NULL
              THEN app.employment_organisation_tags(d.id,p_as_of)
            WHEN t.tags->>'status'='legacy' THEN t.tags||jsonb_build_object('businessUnitId',legacy.business_unit_id)
            ELSE coalesce(recorded.tags,t.tags)
          END AS tags
   FROM dated d
   LEFT JOIN company_tags t ON t.id=d.dated_company
   LEFT JOIN LATERAL (
     SELECT a.business_unit_id FROM public.assignment a
     WHERE t.tags->>'status'='legacy' AND a.employment_id=d.id AND a.tenant_id=d.tenant_id
       AND a.superseded_at IS NULL AND a.valid_from<=p_as_of AND (a.valid_to IS NULL OR a.valid_to>p_as_of)
     ORDER BY a.valid_from DESC,a.id LIMIT 1
   ) legacy ON true
   LEFT JOIN LATERAL (
     SELECT c.tags
     FROM public.employment_organisation_classification c
     JOIN public.company_organisation_run r ON r.id=c.mapping_version_id AND r.tenant_id=c.tenant_id
     WHERE t.tags IS NOT NULL AND t.tags->>'status' IS DISTINCT FROM 'legacy'
       AND c.tenant_id=d.tenant_id AND c.employment_id=d.id AND c.company_id=d.dated_company
       AND c.effective_on<=p_as_of AND r.state='published' AND NOT EXISTS (
         SELECT 1 FROM public.company_organisation_mapping m
         JOIN public.company_organisation_run newer ON newer.id=m.run_id AND newer.tenant_id=m.tenant_id
         WHERE m.tenant_id=d.tenant_id AND m.company_id=d.dated_company AND newer.state='published'
           AND newer.effective_on>c.effective_on AND newer.effective_on<=p_as_of
       )
     ORDER BY c.effective_on DESC,c.created_at DESC,c.id DESC LIMIT 1
   ) recorded ON true
 ),`;

const scalarDated = ` dated AS MATERIALIZED (
   SELECT b.*,app.company_org_employment_company(b.id,p_as_of) AS dated_company
   FROM candidates b
 ),`;

// Resolve corrections only if this tenant has a future correction on the requested day.
// Per employee, keep the first event by sequence even if its company value is null.
const inlineDated = ` future_correction_presence AS MATERIALIZED (
   SELECT EXISTS (
     SELECT 1 FROM public.domain_event ev
     WHERE ev.tenant_id=app.current_tenant_id() AND ev.event_type='employment.information.corrected'
       AND ev.payload->>'effectiveOn'>p_as_of::text
   ) AS present
 ),
 dated AS MATERIALIZED (
   SELECT b.*,a.business_unit_id AS legacy_business_unit_id,
          coalesce(c.previous_company,a.company_id,b.company_id) AS dated_company
   FROM candidates b
   CROSS JOIN future_correction_presence presence
   LEFT JOIN LATERAL (
     SELECT nullif(ev.payload->'before'->>'companyId','')::uuid AS previous_company
     FROM public.domain_event ev
     WHERE presence.present AND ev.tenant_id=b.tenant_id AND ev.subject_employment_id=b.id
       AND ev.event_type='employment.information.corrected' AND ev.payload->>'effectiveOn'>p_as_of::text
     ORDER BY ev.sequence LIMIT 1
   ) c ON true
   LEFT JOIN LATERAL (
     SELECT a.company_id,a.business_unit_id FROM public.assignment a
     WHERE a.tenant_id=b.tenant_id AND a.employment_id=b.id AND a.superseded_at IS NULL
       AND a.valid_from<=p_as_of AND (a.valid_to IS NULL OR a.valid_to>p_as_of)
     ORDER BY a.valid_from DESC,a.id LIMIT 1
   ) a ON true
 ),`;

const effectiveCompanyDated = ` dated_assignments AS MATERIALIZED (
   SELECT a.id,a.employment_id,a.company_id,a.business_unit_id,a.valid_from,
          a.department_id,a.position_id,a.cost_center_id,a.location_id,a.employment_type
   FROM candidates b
   JOIN public.assignment a ON a.tenant_id=b.tenant_id AND a.employment_id=b.id
   WHERE a.superseded_at IS NULL AND a.valid_from<=p_as_of
     AND (a.valid_to IS NULL OR a.valid_to>p_as_of)
 ),
 earliest_tied_assignment AS MATERIALIZED (
   SELECT DISTINCT ON (a.employment_id) a.employment_id,a.company_id,a.business_unit_id
   FROM dated_assignments a ORDER BY a.employment_id,a.valid_from DESC,a.id
 ),
 latest_tied_assignment AS MATERIALIZED (
   SELECT DISTINCT ON (a.employment_id) a.employment_id,a.department_id,a.position_id,a.cost_center_id,
          a.location_id,a.employment_type,a.business_unit_id
   FROM dated_assignments a ORDER BY a.employment_id,a.valid_from DESC,a.id DESC
 ),
 future_information_correction AS MATERIALIZED (
   SELECT DISTINCT ON (ev.subject_employment_id) ev.subject_employment_id,
          nullif(ev.payload->'before'->>'companyId','')::uuid AS previous_company
   FROM candidates b
   JOIN public.domain_event ev ON ev.tenant_id=b.tenant_id AND ev.subject_employment_id=b.id
   WHERE ev.event_type='employment.information.corrected' AND ev.payload->>'effectiveOn'>p_as_of::text
   ORDER BY ev.subject_employment_id,ev.sequence
 ),
 dated AS MATERIALIZED (
   SELECT b.*,a.business_unit_id AS legacy_business_unit_id,
          coalesce(c.previous_company,a.company_id,b.company_id) AS dated_company
   FROM candidates b
   LEFT JOIN future_information_correction c ON c.subject_employment_id=b.id
   LEFT JOIN earliest_tied_assignment a ON a.employment_id=b.id
 ),`;

const legacyAssignment = `   LEFT JOIN LATERAL (
     SELECT a.business_unit_id FROM public.assignment a
     WHERE t.tags->>'status'='legacy' AND a.employment_id=d.id AND a.tenant_id=d.tenant_id
       AND a.superseded_at IS NULL AND a.valid_from<=p_as_of AND (a.valid_to IS NULL OR a.valid_to>p_as_of)
     ORDER BY a.valid_from DESC,a.id LIMIT 1
   ) legacy ON true
`;
const visibleAssignment = `   LEFT JOIN LATERAL (
     SELECT x.department_id,x.position_id,x.business_unit_id,x.cost_center_id,x.location_id,x.employment_type
     FROM public.assignment x
     WHERE x.employment_id=b.id AND x.tenant_id=b.tenant_id AND x.superseded_at IS NULL
       AND x.valid_from<=p_as_of AND (x.valid_to IS NULL OR x.valid_to>p_as_of)
     ORDER BY x.valid_from DESC,x.id DESC LIMIT 1
   ) a ON true`;

// The narrow variant intentionally supports only name/code/email search, dated company, and
// lifecycle status facets. It retains enough dated assignment facts for exact option tuples.
const narrowCandidates = ` candidates AS MATERIALIZED (
   SELECT jsonb_build_object('employmentId',e.id,'name',p.full_name,'email',p.primary_email,
      'employeeCode',e.employee_code,'finalConfirmationDate',e.final_confirmation_date,
      'confirmationDate',e.confirmation_date,'probationEndDate',e.probation_end_date,
      'provisionalEndOn',e.provisional_end_on,'resignationDate',e.resignation_date,
      'lastWorkingDate',e.last_working_date,'terminatedOn',e.terminated_on,
      'blacklistedAt',e.blacklisted_at) AS value,
      e.id,e.tenant_id,e.company_id,e.hired_on,e.grade_id,e.confirmation_date,e.final_confirmation_date
   FROM public.employment e
   JOIN public.person p ON p.id=e.person_id AND p.tenant_id=e.tenant_id
   JOIN permitted_companies pc ON pc.id=e.company_id
   WHERE e.tenant_id=app.current_tenant_id() AND e.voided_at IS NULL
     AND (p_scope IS NULL OR pc.id=ANY(p_scope))
     AND (p_subjects IS NULL OR e.id=ANY(p_subjects))
 ),
 -- Fence the scoped candidates before the raising resolver, then retain its result once per row.
`;

const narrowOutput = ` SELECT v.value||jsonb_build_object(
   'companyId',v.dated_company_id,'company',co.legal_name,
   'departmentId',v.department_id,'employmentType',v.employment_type,
   'businessUnitId',v.dated_bu_id,'businessUnit',bu.name,
   'positionId',v.position_id,'position',COALESCE(NULLIF(btrim(pos.label),''),pos.title)
 )
 FROM visible v
 JOIN public.company co ON co.id=v.dated_company_id AND co.tenant_id=v.tenant_id
 LEFT JOIN public.business_unit bu ON bu.id=v.dated_bu_id AND bu.tenant_id=v.tenant_id
 LEFT JOIN public.position pos ON pos.id=v.position_id AND pos.tenant_id=v.tenant_id
`;

export async function personnelDatedTagsPrototype() {
 const suffix=randomUUID().replaceAll('-','');
 const canonical='app.personnel_filter_rows(date,uuid[])';
 const names={
  baseline:'app.perf_personnel_dated_base_'+suffix,
  candidate:'app.perf_personnel_dated_batch_'+suffix,
  effectiveCompany:'app.perf_personnel_dated_set_'+suffix,
  narrow:'app.perf_personnel_dated_narrow_'+suffix,
  inlineNarrow:'app.perf_personnel_dated_inline_'+suffix,
  pageDetails:'app.perf_personnel_page_details_'+suffix,
 };
 const signature='(date,uuid[],uuid[])';
 const scopeFence='   WHERE p_scope IS NULL OR pc.id=ANY(p_scope)';
 await owner.client.begin(async tx=>{
  const [original]=await tx<{body:string;owner:string}[]>`select prosrc as body,proowner::regrole::text as owner
   from pg_proc where oid=${canonical}::regprocedure`;
  expect(original.body.split(scopeFence)).toHaveLength(2);
  expect(original.body.split(originalTagged)).toHaveLength(2);
  // Only the disposable fixture accepts an explicit sample. It narrows the already authorized admission.
  const sampled=original.body.replace(scopeFence,`   WHERE (p_scope IS NULL OR pc.id=ANY(p_scope))
     AND (p_subjects IS NULL OR (a.value->>'employmentId')::uuid=ANY(p_subjects))`);
  const batched=sampled.replace(originalTagged,batchedTagged);
  expect(batched.split(scalarDated)).toHaveLength(2);
  expect(batched.split(legacyAssignment)).toHaveLength(2);
  expect(batched.split(visibleAssignment)).toHaveLength(2);
  // The original reads the first future correction, even if its company value is null. It then
  // falls back to the dated assignment and finally the current company. Preserve both tie orders.
  const effective=batched.replace(scalarDated,effectiveCompanyDated)
   .replace(legacyAssignment,'').replace('legacy.business_unit_id','d.legacy_business_unit_id')
   .replace(visibleAssignment,'   LEFT JOIN latest_tied_assignment a ON a.employment_id=b.id');
  const admissionStart=batched.indexOf(' admitted AS MATERIALIZED (');
  const datedStart=batched.indexOf(scalarDated);
  const outputStart=batched.indexOf(" SELECT v.value||jsonb_build_object(");
  expect(admissionStart).toBeGreaterThan(0);
  expect(datedStart).toBeGreaterThan(admissionStart);
  expect(outputStart).toBeGreaterThan(datedStart);
  const narrow=batched.slice(0,admissionStart)+narrowCandidates+batched.slice(datedStart,outputStart)+narrowOutput;
  const inline=narrow.replace(scalarDated,inlineDated)
   .replace(legacyAssignment,'').replace('legacy.business_unit_id','d.legacy_business_unit_id');
  const baseCall='app.access_workforce_list_rows() AS a(value)';
  expect(sampled.split(baseCall)).toHaveLength(2);
  // Keep the complete native DTO; the canonical private row owner sees only the chosen page IDs.
  const pageDetails=sampled.replace(baseCall,'app._access_workforce_list_rows(p_subjects) AS a(value)');
  for(const [name,body] of [[names.baseline,sampled],[names.candidate,batched],[names.effectiveCompany,effective],
      [names.narrow,narrow],[names.inlineNarrow,inline],[names.pageDetails,pageDetails]]){
   await tx.unsafe('create function '+name+'(p_as_of date,p_scope uuid[],p_subjects uuid[]) returns setof jsonb language sql stable security definer set search_path=pg_catalog,public,app as $prototype$'+body+'$prototype$');
   await tx.unsafe('revoke all on function '+name+signature+' from public; grant execute on function '+name+signature+' to ai_hr_app');
   const [properties]=await tx<{owner:string;definer:boolean;app:boolean;public_execute:boolean}[]>`select proowner::regrole::text as owner,prosecdef as definer,
    has_function_privilege('ai_hr_app',oid,'EXECUTE') as app,
    exists(select 1 from aclexplode(proacl) where grantee=0 and privilege_type='EXECUTE') as public_execute
    from pg_proc where oid=${name+signature}::regprocedure`;
   expect(properties).toEqual({owner:original.owner,definer:true,app:true,public_execute:false});
  }
 });
 const array=(ids:string[]|null)=>ids===null?sql`null::uuid[]`:sql`array[${sql.join(ids.map(id=>sql`${id}::uuid`),sql`, `)}]::uuid[]`;
 return {
  source:(mode:keyof typeof names,date:string,scope:string[],subjects:string[]|null)=>
   sql`${sql.raw(names[mode])}(${date}::date,${array(scope)},${array(subjects)}) as r(value)`,
  drop:async()=>{await owner.client.unsafe('drop function '+Object.values(names).map(name=>name+signature).join(','));},
 };
}
