import assert from 'node:assert/strict';

export async function snapshotInsightsQueries(owner) {
  // Classify inside the disposable database, so SQL text and IDs never reach the artifact.
  const rows = await owner`
    with classified as (
      select
        case
          when query like '%percentile_cont(%' then
            case
              when query like '%from leave_request %' then 'process-leave'
              when query like '%from claim_request %' then 'process-claims'
              when query like '%from attendance_correction %' then 'process-attendance'
              when query like '%from profile_change_request %' then 'process-profile'
              when query like '%from lc_case %' then 'process-lifecycle'
              when query like '%from hr_orchestration_case %' then 'process-readiness'
              else 'process-other'
            end
          when query like '%app.assistant_action_outcome_summary(%' then 'assistant-outcomes'
          when query like '%app.automatic_chase_outcome_summary(%' then 'automatic-outcomes'
          else 'other'
        end as category,
        calls, total_plan_time, total_exec_time,
        jit_generation_time + jit_inlining_time + jit_optimization_time + jit_emission_time as jit_time
      from pg_stat_statements
      where toplevel and dbid = (select oid from pg_database where datname = current_database())
        and userid = (select oid from pg_roles where rolname = 'ai_hr_app')
    )
    select category, sum(calls)::double precision as calls,
      sum(total_plan_time) as plan_ms, sum(total_exec_time) as exec_ms, sum(jit_time) as jit_ms
    from classified group by category
  `;
  const [info] = await owner`select dealloc::text, stats_reset::text from pg_stat_statements_info`;
  return { info, categories: new Map(rows.map(row => [row.category, row])) };
}

export function summarizeInsightsQueries(before, after) {
  assert.deepEqual(after.info, before.info, 'Statement counters changed generation during browser measurement');
  const elapsed = (row, prior, key) => Math.round(Math.max(0, row[key] - (prior?.[key] ?? 0)) * 10) / 10;
  const changes = [...after.categories.values()].flatMap(row => {
    const prior = before.categories.get(row.category);
    const calls = row.calls - (prior?.calls ?? 0);
    assert(calls >= 0, 'Statement call count regressed');
    const planMs = elapsed(row, prior, 'plan_ms');
    if (!calls && !planMs) return [];
    return [{
      category: row.category, calls, planMs,
      execMs: elapsed(row, prior, 'exec_ms'),
      jitMs: elapsed(row, prior, 'jit_ms'),
    }];
  });
  assert(changes.some(row => row.category.startsWith('process-') && row.calls > 0),
    'Browser measurement captured no process assessment queries');
  return changes.sort((a, b) => b.execMs - a.execMs);
}
