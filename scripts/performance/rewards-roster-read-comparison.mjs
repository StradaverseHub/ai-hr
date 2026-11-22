import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { join } from 'node:path';

const require = createRequire(join(process.cwd(), 'package.json'));
const { sql } = require('drizzle-orm');

export async function compareRewardsRosterReads(source, ctx, draft) {
  const [{ withRewardsTenant }, architecture, performanceOwners] = await Promise.all([
    source('core/module-gate.ts'),
    source('packs/rewards/architecture-source.ts'),
    source('packs/performance/service.ts'),
  ]);
  const { unitId, snapshotDate: date, year, expectedEmploymentIds } = draft;
  assert(Array.isArray(expectedEmploymentIds) && expectedEmploymentIds.length > 20);
  return withRewardsTenant(ctx, async tx => {
    const inputs = Array.from(await tx.execute(sql`
      select employment_id as "employmentId", source->>'positionId' as "positionId"
      from reward_entry
      where tenant_id=${ctx.tenantId}::uuid and unit_id=${unitId}::uuid
      order by employment_id
    `));
    const ids = inputs.map(row => row.employmentId);
    assert.deepEqual(ids, [...new Set(expectedEmploymentIds)].sort());

    const compensationColumns = sql`c.id, c.basic_salary::text as basic_salary, c.currency, c.pay_mode, c.valid_from::text as valid_from`;
    const currentCompensation = sql`c.valid_from <= ${date}::date
      and (c.valid_to is null or c.valid_to > ${date}::date) and c.superseded_at is null`;
    const closedReview = sql`r.closed_at is not null
      and cycle.period_start <= ${year + '-12-31'}::date and cycle.period_end >= ${year + '-01-01'}::date`;
    const historyColumns = sql`c.id, c.basic_salary::text as basic_salary, c.valid_from::text as valid_from`;
    const historicalCompensation = sql`c.superseded_at is null and c.valid_from <= ${year + 1 + '-12-31'}::date`;

    const perEmployment = async () => {
      const results = [];
      for (const { employmentId, positionId } of inputs) {
        const [compensation] = await tx.execute(sql`
          select ${compensationColumns} from compensation c
          where c.employment_id=${employmentId}::uuid and ${currentCompensation}
          order by c.valid_from desc limit 1
        `);
        const [closed] = await tx.execute(sql`
          select r.id,r.overall_rating from performance_review r join review_cycle cycle on cycle.id=r.cycle_id
          where r.employment_id=${employmentId}::uuid and ${closedReview}
          order by r.closed_at desc,r.id desc limit 1
        `);
        const history = await tx.execute(sql`
          select ${historyColumns} from compensation c
          where c.employment_id=${employmentId}::uuid and ${historicalCompensation}
          order by c.valid_from,c.id
        `);
        results.push({
          employmentId, compensation: compensation ?? null, closed: closed ?? null, history: Array.from(history),
          architecture: await architecture.rewardArchitectureForSourceTx(tx, unitId, employmentId, positionId, date),
          onehr: await performanceOwners.onehrRewardResultTx(tx, employmentId, year, unitId),
        });
      }
      return results;
    };

    const batched = async () => {
      const selection = sql`${'{' + ids.join(',') + '}'}::uuid[]`;
      const compensation = await tx.execute(sql`
        select distinct on (c.employment_id) c.employment_id as "employmentId", ${compensationColumns}
        from compensation c where c.employment_id=any(${selection}) and ${currentCompensation}
        order by c.employment_id,c.valid_from desc
      `);
      const closed = await tx.execute(sql`
        select distinct on (r.employment_id) r.employment_id as "employmentId",r.id,r.overall_rating
        from performance_review r join review_cycle cycle on cycle.id=r.cycle_id
        where r.employment_id=any(${selection}) and ${closedReview}
        order by r.employment_id,r.closed_at desc,r.id desc
      `);
      const history = await tx.execute(sql`
        select c.employment_id as "employmentId", ${historyColumns}
        from compensation c where c.employment_id=any(${selection}) and ${historicalCompensation}
        order by c.employment_id,c.valid_from,c.id
      `);
      const architectureById = await architecture.rewardArchitectureForSourcesTx(tx, unitId, inputs, date);
      const onehrById = await performanceOwners.onehrRewardResultsTx(tx, ids, year, unitId);
      const index = rows => new Map(rows.map(({ employmentId, ...row }) => [employmentId, row]));
      const compensationById = index(compensation);
      const closedById = index(closed);
      const historyById = new Map();
      for (const { employmentId, ...row } of history) {
        const rows = historyById.get(employmentId) ?? [];
        rows.push(row);
        historyById.set(employmentId, rows);
      }
      return ids.map(employmentId => ({
        employmentId,
        compensation: compensationById.get(employmentId) ?? null,
        closed: closedById.get(employmentId) ?? null,
        history: historyById.get(employmentId) ?? [],
        architecture: architectureById.get(employmentId) ?? null,
        onehr: onehrById.get(employmentId) ?? null,
      }));
    };

    const rounds = [];
    let population;
    const branches = [['perEmployment', perEmployment], ['batched', batched]];
    for (let pass = 0; pass < 4; pass++) {
      const results = {};
      const timings = {};
      for (const [name, read] of pass % 2 === 0 ? branches : [...branches].reverse()) {
        const start = performance.now();
        results[name] = await read();
        timings[name] = Math.round(performance.now() - start);
      }
      assert.deepEqual(results.batched, results.perEmployment, 'Rewards roster inputs differ');
      rounds.push(timings);
      population = results.batched;
    }
    const counts = Object.fromEntries(['compensation','closed','architecture','onehr']
      .map(key => [key, population.filter(row => row[key] !== null).length]));
    counts.employmentsWithPayHistory = population.filter(row => row.history.length > 0).length;
    assert(counts.compensation > 20 && counts.employmentsWithPayHistory > 20);
    return {
      scope: 'Five read families over the populated unit roster, using one authorized read-only snapshot',
      employments: ids.length,
      counts,
      statements: { perEmployment: ids.length * 4 + inputs.filter(row => row.positionId).length,
        batched: 4 + Number(inputs.some(row => row.positionId)) },
      pairedMs: rounds,
    };
  }, { readOnlySnapshot: true });
}
