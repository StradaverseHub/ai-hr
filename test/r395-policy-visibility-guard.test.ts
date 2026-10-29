/**
 * r395 / migration 0515 — GUARD: no policy USING clause may call the per-row visibility functions.
 *
 * `app.can_see_employment(col)` / `app.can_see_person(col)` in a USING clause is evaluated once PER SCANNED
 * ROW, and for a non-admin each call walks the caller's reporting tree and department tree (r394 measured
 * 1.5 s for 1,032 feedback_request rows). 0515 rewrote every such clause to the set form
 * `col = ANY ((SELECT app.visible_employment_ids())::uuid[])`, which is an InitPlan computed once per
 * statement. This file keeps it that way:
 *
 *   1. in the MIGRATED schema, the set of policies whose USING still calls either function is EMPTY — a new
 *      policy written in the per-row form turns this red. WITH CHECK may still call them (evaluated per
 *      inserted/updated row, which is the right cost), and does on 34 policies.
 *   2. the policies 0515 rewrote are exactly the fixture's 57 (test/fixtures/r395-policy-quals.json,
 *      generated from pg_policies before and after 0515), each with the fixture's post-0515 USING text and
 *      its WITH CHECK text UNCHANGED from before 0515, except the explicitly pinned 0540 assessment-file, 0560 own-Profile and 0561 user-only Feedback extensions,
 *      the 0676 import-void narrowing (ADR-0157), and the 0691 authorized Bank point-read arm.
 *   3. the migration file's ALTER POLICY statements name exactly those 57 and set no WITH CHECK.
 *   4. the set form really is planned as an InitPlan (the `(SELECT …)` wrapper is load-bearing).
 */
import { readFileSync } from 'node:fs';
import { afterAll, describe, expect, it } from 'vitest';
import { closeAll, owner } from './harness';
import { assertTestingFeedbackPolicyGraph,testingFeedbackHistoricalKeys } from './r395-current-feedback-policies';
import {assertCurrentProfilePolicyGraph,profileHistoricalPolicyKey} from './r395-current-profile-policies';

type Policy = { table: string; policy: string; cmd: string; calls: number; oldQual: string; newQual: string; withCheck: string | null };
const FIXTURE = JSON.parse(readFileSync('test/fixtures/r395-policy-quals.json', 'utf8')) as { policies: Policy[] };
const MIGRATION = readFileSync('db/migrations/0515_set_based_visibility.sql', 'utf8');
const key = (t: string, p: string) => `${t}.${p}`;
// 0540 deliberately adds assigned assessment-file readers and author-owned proof writes.
// Keep 0515's historical fixture intact; pin the exact current policies instead of skipping them.
const assessmentAttachment = {
 qual: '((tenant_id = app.current_tenant_id()) AND ((employment_id = ANY (( SELECT app.visible_employment_ids() AS visible_employment_ids)::uuid[])) OR app.can_admin_perfcomp_employment(employment_id) OR COALESCE(app.assessment_file_read(review_id, evidence_id, id, uploaded_by_user_id, removed_at), false)))',
 withCheck: '((tenant_id = app.current_tenant_id()) AND ((employment_id = ANY (( SELECT app.visible_employment_ids() AS visible_employment_ids)::uuid[])) OR app.can_admin_perfcomp_employment(employment_id) OR COALESCE(app.assessment_file_write(review_id, evidence_id, uploaded_by_user_id), false)))',
};

// 0676 (ADR-0157) deliberately hides a voided employment/person from every ordinary read. It may only NARROW
// visibility: the live USING must be exactly `(voided_at IS NULL) AND (<0515 USING>)`, WITH CHECK unchanged.
const importVoidNarrowed = new Set(['employment.employment_rls', 'person.person_rls']);
const voidNarrowedQual = (qual: string) => `((voided_at IS NULL) AND ${qual})`;

// Pin the reviewed 0691 arm independently of the migration bytes. PostgreSQL normalizes
// the complete expected expression; the temporary policy edit always rolls back.
async function bankPointReadQual(original: string): Promise<string> {
 const expected=`voided_at IS NULL AND tenant_id=app.current_tenant_id() AND CASE
  WHEN (SELECT current_setting('app.bank_import_point_read',true))='on'
  THEN CASE WHEN app.is_admin_for(company_id) THEN true ELSE ${original} END
  ELSE ${original} END`;
 const rollback=new Error('Bank policy normalization rollback');let normalized='';
 try {
  await owner.client.begin(async tx=>{
   await tx.unsafe(`ALTER POLICY employment_rls ON public.employment USING (${expected})`);
   const [row]=await tx.unsafe("select qual from pg_policies where schemaname='public' and tablename='employment' and policyname='employment_rls'");
   expect(row).toBeTruthy();normalized=String(row.qual);throw rollback;
  });
 } catch(error) {if(error!==rollback)throw error;}
 expect(normalized).not.toBe('');return normalized;
}


afterAll(async () => {
  await closeAll();
});

type Row = Record<string, unknown>;
const q = async (text: string, params: unknown[] = []) => (await owner.client.unsafe(text, params as never[])) as unknown as Row[];


describe('r395 — per-row visibility functions are gone from every policy USING clause', () => {
  it('pg_policies: no USING clause calls app.can_see_employment( or app.can_see_person(', async () => {
    const all = await q(`select tablename, policyname, qual, with_check from pg_policies order by tablename, policyname`);
    expect(all.length, 'pg_policies is readable and populated').toBeGreaterThan(200);
    const perRow = all
      .filter((r) => /app\.can_see_(employment|person)\(/.test(String(r.qual ?? '')))
      .map((r) => key(r.tablename as string, r.policyname as string));
    expect(perRow, 'policies whose USING still calls the per-row functions').toEqual([]);
    // WITH CHECK is allowed to (one row per check). It is non-vacuous that some still do.
    const inCheck = all.filter((r) => /app\.can_see_(employment|person)\(/.test(String(r.with_check ?? '')));
    expect(inCheck.length).toBeGreaterThan(0);
  });

  it('the 57 rewritten policies retain exact visibility with the assessment-file, own-Profile and user-only Feedback extensions', async () => {
    expect(FIXTURE.policies.length).toBe(57);
    expect(FIXTURE.policies.filter((p) => /app\.can_see_person\(/.test(p.oldQual)).length, 'six person policies').toBe(6);
    const live = new Map(
      (await q(`select tablename, policyname, qual, with_check, cmd, roles, permissive from pg_policies where schemaname='public'`)).map((r) => [key(r.tablename as string, r.policyname as string), r]),
    );
    const employmentFixture=FIXTURE.policies.find(p=>key(p.table,p.policy)==='employment.employment_rls');
    expect(employmentFixture).toBeTruthy();
    const bankEmploymentQual=await bankPointReadQual(voidNarrowedQual(employmentFixture!.newQual));
    const reconciledFeedbackKeys = new Set<string>();
    for (const p of FIXTURE.policies) {
      // These historical invariants still apply to all 57 fixture entries, including the five 0560/0561 cases.
      expect(p.oldQual, `${key(p.table, p.policy)} old USING called a per-row function`).toMatch(/app\.can_see_(employment|person)\(/);
      expect(p.newQual).toMatch(/visible_(employment|person)_ids\(\)/);
      // can_see_person's admin arm is TRUE for any id (another tenant's person; the row an INSERT … RETURNING
      // is creating) and must stay a row-independent boolean beside the set, never be folded into it.
      if (/app\.can_see_person\(/.test(p.oldQual)) {
        expect(p.newQual, `${key(p.table, p.policy)} keeps the is_admin() arm`).toMatch(/\( SELECT app\.is_admin\(\) AS is_admin\) OR \([a-z_.]+ = ANY \(\( SELECT app\.visible_person_ids\(\)/);
      }
      const historicalKey=key(p.table,p.policy);
      if(testingFeedbackHistoricalKeys.has(historicalKey)||historicalKey===profileHistoricalPolicyKey) {
        reconciledFeedbackKeys.add(historicalKey);
      } else {
        const r = live.get(historicalKey);
        expect(r, `${historicalKey} exists`).toBeTruthy();
        const attachment=p.table==='performance_attachment'&&p.policy==='performance_attachment_rls';
        const expectedQual=attachment?assessmentAttachment.qual:historicalKey==='employment.employment_rls'?bankEmploymentQual:importVoidNarrowed.has(historicalKey)?voidNarrowedQual(p.newQual):p.newQual;
        expect(r!.qual, `${historicalKey} USING`).toBe(expectedQual);
        expect(r!.with_check ?? null, `${historicalKey} WITH CHECK`).toBe(attachment?assessmentAttachment.withCheck:p.withCheck);
      }
    }
    expect(FIXTURE.policies.filter((p)=>importVoidNarrowed.has(key(p.table,p.policy))).length,'both 0676 void-narrowed policies are fixture entries').toBe(2);
    expect([...reconciledFeedbackKeys].sort(), 'exactly five historical entries receive the explicit 0560/0561 reconciliation')
      .toEqual([...testingFeedbackHistoricalKeys,profileHistoricalPolicyKey].sort());
    await assertTestingFeedbackPolicyGraph();
    await assertCurrentProfilePolicyGraph();
  });

  it('the migration ALTERs exactly the fixture policies, USING only', () => {
    const alters = [...MIGRATION.matchAll(/^ALTER POLICY "([a-z0-9_]+)" ON "([a-z0-9_]+)"\n([\s\S]*?);\n--> statement-breakpoint/gm)];
    expect(alters.length).toBe(57);
    const inFile = alters.map((m) => key(m[2], m[1])).sort();
    expect(inFile).toEqual(FIXTURE.policies.map((p) => key(p.table, p.policy)).sort());
    for (const m of alters) {
      expect(m[3], `${m[2]}.${m[1]} sets no WITH CHECK`).not.toMatch(/WITH CHECK/);
      expect(m[3], `${m[2]}.${m[1]} no per-row call left`).not.toMatch(/can_see_(employment|person)/);
      expect(m[3]).toMatch(/^\s+USING \(/);
    }
  });

  it('the set form is an InitPlan (evaluated once per statement), not a per-row call', async () => {
    const plans: string[] = [];
    await owner.client.begin(async (tx) => {
      await tx.unsafe(`select set_config('app.tenant_id', gen_random_uuid()::text, true), set_config('app.user_id', gen_random_uuid()::text, true)`);
      await tx.unsafe(`set local role ai_hr_app`);
      for (const t of ['feedback_request', 'leave_request', 'person', 'employment',
        'attendance_workflow_template', 'attendance_workflow_setting', 'attendance_workflow_request', 'attendance_workflow_decision', 'performance_kpi_library']) {
        const rows = (await tx.unsafe(`explain (costs off) select * from "${t}"`)) as unknown as Row[];
        plans.push(rows.map((r) => r['QUERY PLAN']).join('\n'));
      }
    });
    for (const p of plans) {
      expect(p).toMatch(/InitPlan/);
      expect(p).toMatch(/ANY \(\$\d+\)|= ANY \(\(InitPlan/);
      expect(p).not.toMatch(/can_see_(employment|person)/);
    }
  });
});

// The board's SELECT policies added after 0515 must preserve their exact read graph.
// In particular, workflow-v2 participants can retain a request without Personnel visibility,
// and payroll administrators have a separate overtime-assignment read arm.
const boardPolicies = [
  {table:'attendance_group_policy_revision',policy:'attendance_group_policy_read',oldQual:
   'tenant_id=app.current_tenant_id() AND (SELECT app.attendance_policy_principal_current()) AND (app.is_admin_for(company_id) OR EXISTS(SELECT 1 FROM public.employment e WHERE e.tenant_id=attendance_group_policy_revision.tenant_id AND e.company_id=attendance_group_policy_revision.company_id AND app.can_see_employment(e.id)) OR EXISTS(SELECT 1 FROM public.assignment a WHERE a.tenant_id=attendance_group_policy_revision.tenant_id AND a.company_id=attendance_group_policy_revision.company_id AND a.superseded_at IS NULL AND app.can_see_employment(a.employment_id)))'},
  {table:'attendance_policy_final_receipt',policy:'attendance_policy_final_receipt_read',oldQual:
   'tenant_id=app.current_tenant_id() AND (SELECT app.attendance_policy_principal_current()) AND(app.can_see_employment(employment_id) OR app.can_admin_payroll_for(company_id))'},

  { table: 'employment_holiday_calendar', policy: 'employment_holiday_calendar_read', oldQual:
    'tenant_id=app.current_tenant_id() AND app.can_see_employment(employment_id)' },
  { table: 'replacement_holiday', policy: 'replacement_holiday_read', oldQual:
    'tenant_id=app.current_tenant_id() AND app.can_see_employment(employment_id)' },
  { table: 'replacement_holiday_revision', policy: 'replacement_holiday_revision_read', oldQual:
    'tenant_id=app.current_tenant_id() AND app.can_see_employment(employment_id)' },
  { table: 'attendance_workflow_reassignment', policy: 'attendance_workflow_reassignment_read', oldQual:
    'tenant_id=app.current_tenant_id() AND EXISTS(SELECT 1 FROM public.attendance_workflow_request w WHERE w.id=request_id AND (app.can_see_employment(w.employment_id) OR app.attendance_workflow_v2_read(w.correction_id)))' },
  { table: 'overtime_pattern_assignment_employment', policy: 'overtime_assignment_employment_read', oldQual:
    'tenant_id=app.current_tenant_id() AND(app.is_admin() OR app.can_see_employment(employment_id) OR app.can_admin_payroll_employment(employment_id))' },
];

describe('0558 — board policies retain every read arm and statement-scoped visibility', () => {
  it.each(boardPolicies)('$table.$policy changes only the proven-equivalent visibility predicate', async (p) => {
    const [live] = await q(`select qual, with_check, cmd from pg_policies where schemaname='public' and tablename=$1 and policyname=$2`, [p.table, p.policy]);
    expect(live, key(p.table, p.policy)).toBeTruthy();
    expect(live.cmd).toBe('SELECT');
    expect(live.with_check).toBeNull();
    expect([...p.oldQual.matchAll(/app\.can_see_employment\(([a-z_.]+)\)/g)]).toHaveLength(p.table==='attendance_group_policy_revision'?2:1);
    const expected = p.oldQual.replace(/app\.can_see_employment\(([a-z_.]+)\)/g,
      '$1=ANY((SELECT app.visible_employment_ids())::uuid[])');
    // Let PostgreSQL normalize both expressions. Compare the complete qual, including the tenant
    // fence, correlated workflow EXISTS, workflow-v2 exception and separate payroll/admin arms.
    // The transaction always rolls back; a failed assertion cannot leave a test-mutated policy.
    const rollback = new Error('policy normalization rollback');
    try {
      await owner.client.begin(async (tx) => {
        await tx.unsafe(`alter policy "${p.policy}" on public."${p.table}" using (${expected})`);
        const [parsed] = await tx.unsafe(`select qual, with_check from pg_policies where schemaname='public' and tablename=$1 and policyname=$2`, [p.table, p.policy]);
        expect(live.qual, `${key(p.table, p.policy)} exact USING`).toBe(parsed.qual);
        expect(parsed.with_check, 'SELECT policy remains read-only').toBe(live.with_check);
        throw rollback;
      });
    } catch (error) {
      if (error !== rollback) throw error;
    }
  });

  it.each(boardPolicies)('$table uses an InitPlan, never per-row visibility', async (p) => {
    let plan = '';
    await owner.client.begin(async (tx) => {
      await tx.unsafe(`select set_config('app.tenant_id', gen_random_uuid()::text, true), set_config('app.user_id', gen_random_uuid()::text, true)`);
      await tx.unsafe('set local role ai_hr_app');
      const rows = await tx.unsafe(`explain (costs off) select * from public."${p.table}"`);
      plan = rows.map(r => r['QUERY PLAN']).join('\n');
    });
    expect(plan).toMatch(/InitPlan/);
    expect(plan).toMatch(/ANY \(\$\d+\)|= ANY \(\(InitPlan/);
    expect(plan).not.toMatch(/can_see_(employment|person)/);
  });
});
