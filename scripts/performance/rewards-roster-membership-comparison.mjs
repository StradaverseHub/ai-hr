import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { join } from 'node:path';

const require = createRequire(join(process.cwd(), 'package.json'));
const { sql } = require('drizzle-orm');

export async function compareRewardsRosterMembership(source, ctx, draft) {
  const [{ withRewardsTenant }, { employedByCompanyDuring }, { personnelGroupingReadinessTx }] = await Promise.all([
    source('core/module-gate.ts'),
    source('core/employment-company.ts'),
    source('core/personnel-quality.ts'),
  ]);
  const { companyId, businessUnitId, snapshotDate: at, expectedEmploymentIds, expectedReadiness, repeat = 4 } = draft;
  return withRewardsTenant(ctx, async tx => {
    const companyAtDate = sql`${employedByCompanyDuring(companyId, at, at)}
      and employment.hired_on <= ${at}::date
      and (employment.terminated_on is null or employment.terminated_on > ${at}::date)`;
    const companyEmployees = sql`
      select employment.id,employment.employee_code
      from employment join person on person.id=employment.person_id
      where ${companyAtDate}
    `;
    const assignmentAtDate = sql`assignment.valid_from <= ${at}::date
      and (assignment.valid_to is null or assignment.valid_to > ${at}::date) and assignment.superseded_at is null`;
    const tags = sql`app.employment_organisation_tags(employment.id,${at}::date)`;
    const belongsToBusinessUnit = tags => sql`(case when ${tags}->>'status'='legacy' then assignment.business_unit_id
      else (${tags}->>'businessUnitId')::uuid end)=${businessUnitId}::uuid`;
    const order = sql`order by employment.employee_code,employment.id`;

    const measure = async work => {
      const started = performance.now();
      const value = await work();
      return { value, ms: Math.round(performance.now() - started) };
    };
    const original = async () => {
      const company = await measure(() => tx.execute(companyEmployees));
      const readiness = await measure(() => personnelGroupingReadinessTx(tx, ctx, {
        employmentIds: company.value.map(row => row.id), asOf: at,
      }));
      const members = await measure(() => tx.execute(sql`
        select employment.id,assignment.id as assignment_id,assignment.position_id
        from employment join person on person.id=employment.person_id
        join assignment on assignment.employment_id=employment.id
        where ${companyAtDate} and ${belongsToBusinessUnit(tags)} and ${assignmentAtDate}
        ${order}
      `));
      return {
        readiness: readiness.value,
        members: Array.from(members.value),
        timing: { companyMs: company.ms, readinessMs: readiness.ms, businessUnitMs: members.ms },
      };
    };
    const reuseTags = async () => {
      const rows = await tx.execute(sql`
        with candidates as materialized (${companyEmployees}),
        tagged_employments as materialized (
          select candidates.*, app.employment_organisation_tags(candidates.id,${at}::date) as tags
          from candidates
        )
        select employment.id,employment.tags,assignment.id as assignment_id,assignment.position_id
        from tagged_employments employment
        left join assignment on assignment.employment_id=employment.id
          and ${assignmentAtDate} and ${belongsToBusinessUnit(sql`employment.tags`)}
        ${order}
      `);
      const readinessById = new Map();
      const members = [];
      for (const { id, tags, assignment_id, position_id } of rows) {
        assert(tags?.companyId && ['legacy','ready','pending'].includes(tags.status), 'Organisation grouping authority unavailable');
        readinessById.set(id, {
          employmentId:id,
          companyId:tags.companyId,
          ready:tags.status!=='pending',
          reason:tags.status==='pending'
            ? tags.reason==='missing_business_unit' ? 'missing_business_unit' : 'company_not_in_structure'
            : null,
        });
        if (assignment_id) members.push({ id, assignment_id, position_id });
      }
      return { readiness: [...readinessById.values()], members };
    };

    const sortById = rows => [...rows].sort((a,b) => a.employmentId.localeCompare(b.employmentId));
    const rounds = [];
    for (let pass=0; pass<repeat; pass++) {
      let baseline, candidate;
      if (pass%2===0) {
        baseline = await original();
        candidate = await measure(reuseTags);
      } else {
        candidate = await measure(reuseTags);
        baseline = await original();
      }
      assert.deepEqual(baseline.members,candidate.value.members,'Dated assignments and roster order differ');
      assert.deepEqual(sortById(baseline.readiness),sortById(candidate.value.readiness),'Company grouping readiness differs');
      assert.deepEqual(baseline.members.map(row=>row.id).sort(),[...expectedEmploymentIds].sort());
      if (expectedReadiness) assert.deepEqual(sortById(candidate.value.readiness), sortById(expectedReadiness));
      const { companyMs, readinessMs, businessUnitMs } = baseline.timing;
      rounds.push({
        ...baseline.timing, originalMs: companyMs + readinessMs + businessUnitMs, reusedTagsMs: candidate.ms,
        candidateEmployments: baseline.readiness.length, readyEmployments: baseline.readiness.filter(row=>row.ready).length,
        rosterEmployments: baseline.members.length,
      });
    }
    return { scope:'Dated company and business-unit membership on the same authorized read-only snapshot', rounds };
  },{readOnlySnapshot:true});
}
