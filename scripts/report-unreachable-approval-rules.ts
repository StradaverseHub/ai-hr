/**
 * WHICH APPROVAL RULES NEVER DECIDE ANYTHING, AND WHY — the deliverable of board item b2b31767.
 *
 * The reporter was told "245 active approval rules; 74 ever decide an approver, 171 never do", and
 * approved a plan whose entire content is: produce that list, grouped by company and leave type, with
 * the scope that makes each one unreachable spelled out in words. This is that list.
 *
 * ⚠️ IT ADDS NO RANKING OF ITS OWN. It calls `replayApprovalRouting(ctx, { coverage: true })` — the same
 * function the baseline replay calls, which resolves through `decideApproval`, THE matcher a real leave
 * request uses. A rule counted here as never-winning is never-winning by the engine's own judgement.
 * Re-implementing the ranking in this file would be precisely the defect the a6fe37fc item existed to
 * remove ("one matcher, two callers"), and it would make this report capable of disagreeing with the
 * product about who approves.
 *
 * WHAT IT ADDS on top of coverage, all of it reads:
 *   1. the scope columns, which coverage does not carry (it returns ruleId/companyId/ruleName/
 *      leaveTypeId/wins only), joined from leave_approval_policy;
 *   2. those ids resolved to the words an administrator uses — "Finance", "Executive", "Full-time".
 *      The console output names them "(unnamed rule)" beside a uuid, which is useless to the reporter.
 *      THAT TRANSLATION IS THE WORK;
 *   3. the distinction the reporter acts differently on:
 *        UNREACHABLE — no active employment satisfies the scope. Waiting for people not yet hired, or
 *                      left over.
 *        SHADOWED    — employees DO match, but a more specific rule beats it every time. Deleting it
 *                      changes nothing today.
 *      That is a MEMBERSHIP TEST over the same routing subjects the replay already read — "does any
 *      active subject match this scope" — and deliberately NOT a second ranking.
 *
 * READ-ONLY by construction: the coverage read happens inside `replayApprovalRouting`'s transaction,
 * which Postgres itself marks READ ONLY and which only ever exits by throwing. This file opens no
 * transaction of its own and imports no writer. It refuses to report a tenant whose transaction the
 * database did not confirm read-only, exactly as the replay script does.
 *
 * RUN IT ON THE BOX BY SOURCING THE ENV FILE — `node --env-file=` exits 9 there (bad option; the server
 * is node v18.19.1). AGENTS 21, and the reason 23 other scripts document an invocation that cannot run:
 *
 *   cd /opt/ai-hr && set -a && . ./.env.production && set +a \
 *     && node --import tsx scripts/report-unreachable-approval-rules.ts > /tmp/unreachable-rules.md
 */
import { eq } from 'drizzle-orm';
import { createDb } from '../db/client';
// THROUGH THE PACK FACADE, NOT core/ DIRECTLY (ADR-0080 D9/D11). packs/leave/service re-exports
// core/leave-approval-consolidation wholesale, so this is the same function the replay uses — but
// importing core/ from a new file trips test/leave-pack-drift.test.ts's ratchet, and the fix for
// that is NEVER test/pack-drift-allowlist.json: that list is audited debt and only shrinks
// (AGENTS 15). This file turned the gate red on exactly that.
import { replayApprovalRouting, type RoutingSubject } from '../packs/leave/service';
import {
  businessUnit,
  company,
  department,
  gradeGroup,
  jobGrade,
  leaveApprovalPolicy,
  leaveType,
  position,
  tenant,
} from '../db/schema';

/** The six scope dimensions a rule can carry, in the order an administrator reads them. */
const DIMENSIONS = [
  ['businessUnitId', 'Business unit'],
  ['departmentId', 'Department'],
  ['positionId', 'Position'],
  ['gradeId', 'Job grade'],
  ['gradeGroupId', 'Grade group'],
  ['employmentType', 'Employment type'],
] as const;

type ScopeRow = {
  id: string;
  companyId: string;
  leaveTypeId: string | null;
  name: string | null;
  businessUnitId: string | null;
  departmentId: string | null;
  positionId: string | null;
  gradeId: string | null;
  gradeGroupId: string | null;
  employmentType: string | null;
  minDays: number | null;
  maxDays: number | null;
};

/** Does ANY active routing subject satisfy every dimension this rule constrains? A membership test —
 *  deliberately not a ranking. A null on a dimension means the rule does not constrain it. */
function anySubjectMatches(rule: ScopeRow, subjects: RoutingSubject[]): boolean {
  return subjects.some((s) => {
    if (s.companyId !== rule.companyId) return false;
    const a = s.attrs as unknown as Record<string, unknown>;
    for (const [key] of DIMENSIONS) {
      const want = rule[key as keyof ScopeRow];
      if (want == null) continue;
      if (a[key] !== want) return false;
    }
    return true;
  });
}

async function main() {
  const ownerUrl = process.env.MIGRATION_DATABASE_URL;
  if (!ownerUrl) {
    console.error('report-unreachable-approval-rules requires MIGRATION_DATABASE_URL to enumerate tenants.');
    process.exit(1);
  }
  const owner = createDb(ownerUrl);
  const tenants = await owner.db.select({ id: tenant.id, name: tenant.name }).from(tenant);

  const out: string[] = [];
  let refused = 0;

  for (const t of tenants) {
    // SYSTEM context, exactly as the replay script builds it: hr_admin authorises the read, no userId so
    // nothing is attributed to a person, and no entitlementsExempt marker.
    const replay = await replayApprovalRouting({ tenantId: t.id, roles: ['hr_admin'] }, { coverage: true });
    if (!replay.readOnlyEnforced) {
      // The property this report's whole case rests on did not hold. Say so; do not print a reassuring
      // list out of a transaction that could have written.
      console.error(`✗ ${t.name}: the database did not confirm a READ ONLY transaction — tenant skipped.`);
      refused += 1;
      continue;
    }
    const cov = replay.coverage;
    if (!cov || cov.rules.length === 0) continue;

    const never = cov.rules.filter((r) => r.wins === 0);

    // Explicit per table rather than a generic helper: the label column is NOT uniform — position uses
    // `title` (its `name` does not exist) while the others use `name`, and a union of table types loses
    // the common column anyway. Naming each one is what makes that difference visible.
    const idName = async (rows: { id: string; name: string }[]) => new Map(rows.map((r) => [r.id, r.name]));
    const names: Record<string, Map<string, string>> = {
      businessUnitId: await idName(
        await owner.db.select({ id: businessUnit.id, name: businessUnit.name }).from(businessUnit).where(eq(businessUnit.tenantId, t.id)),
      ),
      departmentId: await idName(
        await owner.db.select({ id: department.id, name: department.name }).from(department).where(eq(department.tenantId, t.id)),
      ),
      positionId: await idName(
        await owner.db.select({ id: position.id, name: position.title }).from(position).where(eq(position.tenantId, t.id)),
      ),
      gradeId: await idName(
        await owner.db.select({ id: jobGrade.id, name: jobGrade.name }).from(jobGrade).where(eq(jobGrade.tenantId, t.id)),
      ),
      gradeGroupId: await idName(
        await owner.db.select({ id: gradeGroup.id, name: gradeGroup.name }).from(gradeGroup).where(eq(gradeGroup.tenantId, t.id)),
      ),
    };
    const companies = new Map(
      (await owner.db.select({ id: company.id, name: company.legalName }).from(company).where(eq(company.tenantId, t.id))).map(
        (r) => [r.id, r.name],
      ),
    );
    const leaveTypes = new Map(
      (await owner.db.select({ id: leaveType.id, name: leaveType.name }).from(leaveType).where(eq(leaveType.tenantId, t.id))).map(
        (r) => [r.id, r.name],
      ),
    );
    const scopes = new Map<string, ScopeRow>(
      (
        await owner.db
          .select({
            id: leaveApprovalPolicy.id,
            companyId: leaveApprovalPolicy.companyId,
            leaveTypeId: leaveApprovalPolicy.leaveTypeId,
            name: leaveApprovalPolicy.ruleName,
            businessUnitId: leaveApprovalPolicy.businessUnitId,
            departmentId: leaveApprovalPolicy.departmentId,
            positionId: leaveApprovalPolicy.positionId,
            gradeId: leaveApprovalPolicy.gradeId,
            gradeGroupId: leaveApprovalPolicy.gradeGroupId,
            employmentType: leaveApprovalPolicy.employmentType,
            minDays: leaveApprovalPolicy.minDays,
            maxDays: leaveApprovalPolicy.maxDays,
          })
          .from(leaveApprovalPolicy)
          .where(eq(leaveApprovalPolicy.tenantId, t.id))
      ).map((r) => [r.id, r as ScopeRow]),
    );

    out.push(`# Approval rules that never decide anything — ${t.name}`);
    out.push('');
    out.push(`Read over your live configuration on ${new Date().toISOString().slice(0, 10)}. Nothing was written.`);
    out.push('');
    out.push(
      `**${cov.rules.length} active rules. ${cov.rules.length - never.length} decide at least one approver. ` +
        `${never.length} decide none.** Across ${cov.decisions} routing decisions covering ` +
        `${replay.employmentsCovered} employees, ${cov.bySource.rule} were decided by one of your rules and ` +
        `${cov.bySource.fallback} fell through to the built-in chain.`,
    );
    out.push('');

    const byCompany = new Map<string, typeof never>();
    for (const r of never) {
      const k = companies.get(r.companyId) ?? r.companyId;
      if (!byCompany.has(k)) byCompany.set(k, []);
      byCompany.get(k)!.push(r);
    }

    for (const [companyName, rules] of [...byCompany].sort((a, b) => a[0].localeCompare(b[0]))) {
      out.push(`## ${companyName} — ${rules.length} rule(s) that never decide`);
      out.push('');
      const byType = new Map<string, typeof rules>();
      for (const r of rules) {
        const k = r.leaveTypeId ? (leaveTypes.get(r.leaveTypeId) ?? r.leaveTypeId) : 'Every leave type';
        if (!byType.has(k)) byType.set(k, []);
        byType.get(k)!.push(r);
      }
      for (const [typeName, group] of [...byType].sort((a, b) => a[0].localeCompare(b[0]))) {
        out.push(`### ${typeName}`);
        out.push('');
        out.push('| Rule | Why it never decides | Scope |');
        out.push('|---|---|---|');
        for (const r of group) {
          const sc = scopes.get(r.ruleId);
          if (!sc) continue;
          const parts = DIMENSIONS.flatMap(([key, human]) => {
            const v = sc[key as keyof ScopeRow];
            if (v == null) return [];
            const shown =
              key === 'employmentType' ? String(v) : (names[key]?.get(String(v)) ?? `(deleted: ${String(v)})`);
            return [`${human}: ${shown}`];
          });
          if (sc.minDays != null) parts.push(`Minimum days: ${sc.minDays}`);
          if (sc.maxDays != null) parts.push(`Maximum days: ${sc.maxDays}`);
          const reason = anySubjectMatches(sc, replay.subjects)
            ? 'SHADOWED — employees match it, but a more specific rule wins every time'
            : 'UNREACHABLE — no active employee is in this scope';
          out.push(
            `| ${r.ruleName ?? '(unnamed)'} | ${reason} | ${parts.length ? parts.join(' · ') : 'No scope — applies to everyone'} |`,
          );
        }
        out.push('');
      }
    }
  }

  out.push('---');
  out.push('');
  out.push(
    'UNREACHABLE means nobody currently on your books is in that scope. The rule may be waiting for ' +
      'people you have not hired, or it may be left over — that is a judgement about your business, not ' +
      'about the software.',
  );
  out.push('');
  out.push(
    'SHADOWED means employees DO match the rule, but another, more specific rule reaches them first. ' +
      'Deleting a shadowed rule changes nothing today; changing the rule that beats it would expose it.',
  );

  console.log(out.join('\n'));
  if (refused > 0) process.exit(1);
}

void main();
