// One-shot PRE-DEPLOY REPORT (feedback 9cbf5e0d, r81b) — the before-and-after list the reporter was
// promised, printed BEFORE migration 0326 drops `assignment.status` and the `assignment_status` enum.
//
// WHY A SEPARATE SCRIPT WHEN 0326 ALSO PRINTS. The migration's own STEP 1 notice block writes the same
// facts into the deploy log, which is the durable audit record. This script exists so the mapping can be
// READ AND AGREED first, on a day of someone's choosing, without applying anything — "we will show you
// that mapping before it is applied" is not satisfied by output that only appears at the moment of
// application. It is therefore STRICTLY READ-ONLY: there is no --apply flag, and it issues no UPDATE, no
// DDL and no writes of any kind. Run it, read it, then deploy.
//
// It is also safe to run AFTER the migration: every query is guarded on the column/type still existing, so
// a post-deploy run reports "already applied" instead of erroring.
//
//   node --env-file=.env.production --import tsx scripts/report-employee-status-retirement.ts
//
// WHAT IT REPORTS
//   1. Per employment holding one of the three RETIRED stored values (on_leave / offboarding /
//      terminated): the stored value beside the status that employee is ALREADY being shown.
//   2. Every employment whose stored value disagreed with the displayed status, as a count — the size of
//      the drift that made this request necessary. These are NOT status changes: the displayed value was
//      authoritative before this migration and is untouched by it.
//   3. Every performance review cycle whose eligibility rules name a status, with the exact remap 0326
//      will apply. This is the ONE place where behaviour genuinely changes, so it is listed by cycle name.
import { createDb } from '../db/client';

type RetiredRow = { employee_code: string | null; company: string; stored: string; derived: string };
type DriftRow = { n: string };
type CycleRow = { id: string; name: string; company: string | null; statuses: string[] };

/** The retirement mapping, single-sourced with migration 0326 STEP 2. */
const REMAP: Record<string, string> = {
  on_leave: 'active',
  offboarding: 'active_serving_notice',
  terminated: 'resigned',
};
const remap = (v: string) => REMAP[v] ?? v;

async function main() {
  const ownerUrl = process.env.MIGRATION_DATABASE_URL ?? process.env.DATABASE_URL;
  if (!ownerUrl) {
    console.error('report-employee-status-retirement requires MIGRATION_DATABASE_URL (or DATABASE_URL).');
    process.exit(1);
  }
  // createDb returns the raw postgres.js tagged-template client as `client`; this script speaks only raw
  // SQL (it must run against a schema that still has a column db/schema.ts no longer declares).
  const { client: sql } = createDb(ownerUrl);

  const [{ present }] = (await sql`
    select exists (
      select 1 from information_schema.columns
      where table_schema = 'public' and table_name = 'assignment' and column_name = 'status'
    ) as present
  `) as unknown as [{ present: boolean }];

  console.log('Employee Status retirement — read-only report (9cbf5e0d / migration 0326)');
  console.log('─'.repeat(100));

  if (!present) {
    console.log('assignment.status is already dropped: migration 0326 has been applied. Nothing to report.');
    console.log('The per-employment before/after is in the deploy log from the run that applied it.');
    await sql.end();
    return;
  }

  // The derivation below is core/employment-status-sql.ts verbatim. Duplicated here (and nowhere else)
  // because this script must run against a database that still has the old column, using only raw SQL.
  const derived = sql`
    case
      when e.blacklisted_at is not null then 'blacklisted'
      when least(e.resignation_date, e.last_working_date, e.terminated_on) is not null
           and current_date >= least(e.resignation_date, e.last_working_date, e.terminated_on) then 'resigned'
      when least(e.resignation_date, e.last_working_date, e.terminated_on) is not null then 'active_serving_notice'
      when coalesce(e.final_confirmation_date, e.confirmation_date) is not null
           and current_date < coalesce(e.final_confirmation_date, e.confirmation_date) then 'probation'
      else 'active'
    end
  `;

  // ── 1. Employments carrying a retired stored value ──────────────────────────────────────────────
  const retired = (await sql`
    select e.employee_code, c.legal_name as company, a.status::text as stored, ${derived} as derived
    from assignment a
    join employment e on e.id = a.employment_id
    join company c on c.id = e.company_id
    where a.valid_to is null and a.superseded_at is null
      and a.status::text in ('on_leave', 'offboarding', 'terminated')
    order by c.legal_name, e.employee_code
  `) as unknown as RetiredRow[];

  console.log(`\n1. RETIRED STATUS VALUES — ${retired.length} employment(s) still carry one.\n`);
  if (retired.length === 0) {
    console.log('   (none — no stored row holds On Leave, Offboarding or Terminated)');
  } else {
    console.log('   These employees are ALREADY shown the "displayed" value on every screen; the stored');
    console.log('   value is the one being removed. Nobody\'s status moves when 0326 runs.\n');
    for (const r of retired) {
      console.log(
        `   ${(r.employee_code ?? '(no code)').padEnd(14)} ${r.company.slice(0, 30).padEnd(32)} stored "${r.stored}" (retired)  ->  displayed "${r.derived}"`,
      );
    }
  }

  // ── 2. Total drift between the stored column and the displayed status ───────────────────────────
  const [drift] = (await sql`
    select count(*)::text as n
    from assignment a
    join employment e on e.id = a.employment_id
    where a.valid_to is null and a.superseded_at is null
      and a.status::text is distinct from (${derived})
  `) as unknown as [DriftRow];

  console.log(`\n2. STORED-vs-DISPLAYED DRIFT — ${drift.n} employment(s) held a stored value that already`);
  console.log('   disagreed with the status their screens show. This is the drift the request describes.');
  console.log('   It is reported for the record only: these are not changes, and 0326 makes none.');

  // ── 3. Performance eligibility rules — the one real behaviour change ────────────────────────────
  const cycles = (await sql`
    select rc.id, rc.name, c.legal_name as company,
           array(select jsonb_array_elements_text(rc.eligibility_rules -> 'statuses')) as statuses
    from review_cycle rc
    left join company c on c.id = rc.company_id
    where rc.eligibility_rules is not null
      and jsonb_typeof(rc.eligibility_rules -> 'statuses') = 'array'
      and jsonb_array_length(rc.eligibility_rules -> 'statuses') > 0
    order by rc.name
  `) as unknown as CycleRow[];

  console.log(`\n3. PERFORMANCE ELIGIBILITY RULES — ${cycles.length} review cycle(s) filter on status.\n`);
  if (cycles.length === 0) {
    console.log('   (none — no stored eligibility rule names a status, so no cycle changes population)');
  } else {
    console.log('   THIS IS THE ONE PLACE BEHAVIOUR CHANGES. These cycles matched employees against the');
    console.log('   stored column; after 0326 they match against the real derived status.\n');
    for (const c of cycles) {
      const after = [...new Set(c.statuses.map(remap))];
      const changed = JSON.stringify(after) !== JSON.stringify([...new Set(c.statuses)]);
      console.log(
        `   ${c.name.slice(0, 40).padEnd(42)} ${(c.company ?? 'all companies').slice(0, 24).padEnd(26)} [${c.statuses.join(', ')}]  ->  [${after.join(', ')}]${changed ? '' : '   (unchanged)'}`,
      );
    }
  }

  console.log('\n' + '─'.repeat(100));
  console.log('Read-only: nothing was written. Apply migration 0326 to carry this out.');
  await sql.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
