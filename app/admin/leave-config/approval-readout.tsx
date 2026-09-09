import Link from 'next/link';
import { getTranslations } from 'next-intl/server';

import { withTenant, type SessionContext } from '@/db/client';
import { listDepartments, listJobGrades, listLeaveTypes } from '@/core/read';
import { listBusinessUnits, listPositions } from '@/core/admin';
import { listGradeGroups } from '@/core/benefit-scheme';
import {
  decideApproval,
  getLeaveEscalationPolicy,
  loadApprovalRuleSet,
  type ApprovalRuleSet,
  type LeaveEscalationPolicy,
  type LeaveLevelKind,
} from '@/core/leave-approval-policy';
import { listLegacyApprovalRules } from '@/core/leave-approval-consolidation';
import { listApprovalTemplates } from '@/core/leave-approval-template';
import { Card, SectionHeader } from '@/components/ui';
import { leaveConfigScreenHref } from '@/components/leave-config-map';

/**
 * a6fe37fc ROUND 4 — THE TWO READ-ONLY APPROVAL READ-OUTS, and the one place they are implemented.
 *
 * ═══ WHY THIS FILE EXISTS AT ALL: A COLUMN THAT ROUTES LIVE REQUESTS AND HAS NO SCREEN ═══
 *
 * `706d34e8` (r155) removed the per-rule Workflow Matrix from the Approval screen. That removal was
 * right — the matrix was a SECOND EDITOR over the same `leave_approval_policy` rows the Assignment
 * Template section already maintains, which is the duplication the reporter raised the whole item for.
 * But it was the ONLY surface that could show a rule's business unit / department / position scope, and
 * the only one offering a per-rule custom chain. `convertLegacyApprovalRules` PRESERVES those columns,
 * `resolveApprovalChain` still READS them, they still DECIDE WHO APPROVES — and since that commit no
 * screen in the product displays them (IA §4.1).
 *
 * ⚠️ SO READ THIS BEFORE DELETING ANYTHING BELOW: **a read-only read-out of a column that routes live
 * requests is not the editor `706d34e8` removed.** There is no form, no action, no popup and no way to
 * change a rule anywhere in this file — every control that WRITES a chain stays on Approval chains, and
 * both read-outs link there. Making these rows editable again WOULD re-create the duplication; showing
 * them is what makes "why did this request go to that approver?" answerable at all.
 * `test/leave-approval-page-restructure.test.ts` carries that reasoning as an executable case.
 *
 * ═══ ⚠️ IT COMPUTES NO ROUTING OF ITS OWN (IA §2.3 — one matcher, mounted twice) ═══
 *
 * `decideApproval` is THE ranking (core/leave-approval-policy.ts) — `resolveApprovalDecision` is that
 * function plus its two reads, and the approval replay calls it directly over a rule set read once. The
 * tab-5 read-out below does exactly the same: `loadApprovalRuleSet` ONCE for the page, then
 * `decideApproval` per (company × leave type), in memory, with no I/O. A second ranking of these rows
 * that drifts from that one is the defect this item exists to remove, and a read-out that answered
 * differently from the engine would be worse than no read-out.
 *
 * The "not built from a template" list is the same story one level down: `listLegacyApprovalRules`
 * (core/leave-approval-consolidation.ts) is the ONE enumeration of the rows the Assignment Template
 * screen cannot own, and it is what `scripts/convert-approval-rules.ts` counts. This file filters its
 * result; it does not re-derive it with a second `template_id is null` query that could drift from it.
 *
 * SERVER COMPONENTS, deliberately, like every other node in this module: `getTranslations` and plain
 * markup, nothing crossing a boundary (r123 took a production tab down by handing a closure across one;
 * test/server-client-boundary.test.ts pins the class).
 */

/**
 * The seven approver kinds and the `leaveApproval` key each one's label lives under. The SAME vocabulary
 * `app/admin/leave-approval/step-list-editor.tsx` renders — but that file is `'use client'`, so a server
 * component may not call its `kindLabel` helper (test/rsc-boundary-guard.test.ts pins exactly that
 * class of import). Declared here as data rather than borrowed as code, and zero new i18n keys: every
 * one of the seven strings already ships in all six locales.
 */
const LEVEL_LABEL_KEY: Record<LeaveLevelKind, string> = {
  direct_manager: 'manager',
  department_head: 'departmentHead',
  business_unit_head: 'businessUnitHead',
  hr_admin: 'hr',
  hr_manager: 'hrManager',
  payroll: 'payroll',
  custom_role: 'customRole',
};

/** The ordered chain, drawn the way it resolves: step 1 first. Presentational only. */
function ChainSteps({ levels, labels }: { levels: LeaveLevelKind[]; labels: Record<LeaveLevelKind, string> }) {
  return (
    <ol className="flex flex-wrap items-center gap-1.5">
      {levels.map((lv, i) => (
        <li key={`${lv}-${i}`} className="flex items-center gap-1.5">
          {i > 0 ? (
            <span aria-hidden className="text-xs text-muted-foreground">
              →
            </span>
          ) : null}
          <span className="rounded-full bg-muted px-2 py-0.5 text-xs font-medium text-foreground">
            {i + 1}. {labels[lv]}
          </span>
        </li>
      ))}
    </ol>
  );
}

// ────────────────────────────────────────────────────────────────────────────────────────────────────
// 1. The rules that are NOT built from a template — the IA §4.1 restoration
// ────────────────────────────────────────────────────────────────────────────────────────────────────

/** One template-less rule, with every scoping id already resolved to the name an administrator reads. */
export type UntemplatedApprovalRuleRow = {
  id: string;
  companyName: string;
  ruleName: string | null;
  /** null = the rule applies to EVERY leave type (the wildcard the assign form cannot express). */
  leaveTypeName: string | null;
  businessUnit: string | null;
  department: string | null;
  position: string | null;
  jobGrade: string | null;
  gradeGroup: string | null;
  /** The enum value; its label is `leaveApproval.employmentType_<value>`. */
  employmentType: string | null;
  minDays: number | null;
  maxDays: number | null;
  /** The rule's OWN ordered chain. Template-less by construction, so this is its effective chain. */
  levels: LeaveLevelKind[];
};

/**
 * Every ACTIVE rule in the given companies that carries no template.
 *
 * ⚠️ THE FILTER IS `templateId === null`, AND THE OTHER HALF OF `listLegacyApprovalRules` IS DELIBERATELY
 * NOT SHOWN HERE. That enumeration returns two kinds of row — `no-template` and `any-leave-type` — and a
 * row with a template but a null `leave_type_id` IS already on screen: `listTemplateAssignments` returns
 * every active row that carries a template, including the null-leave-type ones, and the assignment list
 * groups them with `firstLeaveTypeId === null`. Listing those again here would be the duplication
 * `706d34e8` removed, in a new place. Only the rows NO surface can show are restored.
 *
 * ⚠️ SCOPED TO THE CALLER'S COMPANIES BY THE CALLER'S OWN LIST. `leave_approval_policy` is readable
 * tenant-wide (the requester resolves their own chain inside their own transaction — see the table's RLS
 * note), so this read returns the whole tenant and the company filter is what keeps a company-scoped
 * admin seeing only their own companies (IA §6.4). It is the same filter the assignment list applies.
 *
 * ⚠️ THE SEVEN CATALOGUE READS ONLY HAPPEN WHEN THERE IS SOMETHING TO LABEL. A tenant whose rules are
 * all template-driven — which is what `scripts/convert-approval-rules.ts` converted production towards —
 * gets ONE query, not eight, on every render of this page. The e4238594 / 706d34e8 precedent, applied
 * before the fact: an embed's data prep left behind is a fan of queries per render for a surface that
 * draws nothing.
 */
export async function loadUntemplatedApprovalRules(
  s: SessionContext,
  companies: { id: string; name: string }[],
): Promise<UntemplatedApprovalRuleRow[]> {
  const companyName = new Map(companies.map((c) => [c.id, c.name]));
  const legacy = await withTenant(s, (tx) => listLegacyApprovalRules(tx));
  const untemplated = legacy.filter((r) => r.templateId === null && companyName.has(r.companyId));
  if (untemplated.length === 0) return [];

  // Archived labels are INCLUDED: a rule may still point at one, it still routes, and "(unknown)" in the
  // scope column is exactly the invisibility this read-out exists to end.
  const [leaveTypes, businessUnits, departments, positions, grades, gradeGroups] = await Promise.all([
    listLeaveTypes(s, { includeArchived: true }),
    listBusinessUnits(s, { includeArchived: true }),
    listDepartments(s, { includeArchived: true }),
    listPositions(s, { includeArchived: true }),
    listJobGrades(s, { includeArchived: true }),
    listGradeGroups(s),
  ]);
  const nameOf = <T extends { id: string }>(rows: T[], pick: (r: T) => string) => {
    const byId = new Map(rows.map((r) => [r.id, pick(r)]));
    return (id: string | null) => (id === null ? null : (byId.get(id) ?? id));
  };
  const leaveTypeName = nameOf(leaveTypes, (x) => x.name);
  const businessUnitName = nameOf(businessUnits, (x) => x.name);
  const departmentName = nameOf(departments, (x) => x.name);
  const positionName = nameOf(positions, (x) => x.title);
  const gradeName = nameOf(grades, (x) => `${x.code} — ${x.name}`);
  const gradeGroupName = nameOf(gradeGroups, (x) => x.name);

  return untemplated.map((r) => ({
    id: r.id,
    companyName: companyName.get(r.companyId) ?? r.companyId,
    ruleName: r.ruleName,
    leaveTypeName: leaveTypeName(r.leaveTypeId),
    businessUnit: businessUnitName(r.businessUnitId),
    department: departmentName(r.departmentId),
    position: positionName(r.positionId),
    jobGrade: gradeName(r.gradeId),
    gradeGroup: gradeGroupName(r.gradeGroupId),
    employmentType: r.employmentType,
    minDays: r.minDays,
    maxDays: r.maxDays,
    levels: r.levels,
  }));
}

/**
 * The read-only list. NO form, NO action, NO edit affordance — see this file's header for why that is
 * the whole point rather than an omission.
 */
export async function UntemplatedApprovalRules({ rows }: { rows: UntemplatedApprovalRuleRow[] }) {
  const t = await getTranslations('leaveApproval');
  const tr = await getTranslations('admin.leaveConfigApprovalChains');
  const labels = Object.fromEntries(
    (Object.keys(LEVEL_LABEL_KEY) as LeaveLevelKind[]).map((k) => [k, t(LEVEL_LABEL_KEY[k])]),
  ) as Record<LeaveLevelKind, string>;

  /** Every non-wildcard dimension of one rule, as `label: value` chips. Empty = matches everyone. */
  const scopeOf = (r: UntemplatedApprovalRuleRow): string[] => {
    const out: string[] = [];
    if (r.businessUnit) out.push(`${t('businessUnit')}: ${r.businessUnit}`);
    if (r.department) out.push(`${t('department')}: ${r.department}`);
    if (r.position) out.push(`${t('position')}: ${r.position}`);
    if (r.jobGrade) out.push(`${t('jobGrade')}: ${r.jobGrade}`);
    if (r.gradeGroup) out.push(`${t('gradeGroup')}: ${r.gradeGroup}`);
    if (r.employmentType) out.push(`${t('employmentType')}: ${t(`employmentType_${r.employmentType}`)}`);
    if (r.minDays !== null) out.push(`${t('minDays')}: ${r.minDays}`);
    if (r.maxDays !== null) out.push(`${t('maxDays')}: ${r.maxDays}`);
    return out;
  };

  return (
    /* `data-readout` is a RENDER PROBE, and it is here on purpose. "A 200 is not a render check": a
       MISSING_MESSAGE or an RSC boundary fault returns 200 with the page's own DOM missing, and grepping
       the HTML for a translated label is a FALSE POSITIVE because Next.js embeds the whole i18n catalogue
       in the payload (HANDOFF → Rendering and verification). A data attribute that exists in exactly one
       component is the cheapest thing that can only come from this component actually rendering. */
    <Card data-readout="untemplated-approval-rules">
      <SectionHeader title={tr('untemplatedTitle')} count={rows.length} />
      <div className="space-y-3 px-4 py-3">
        <p className="text-xs text-muted-foreground">{tr('untemplatedHint')}</p>
        <p className="text-xs text-muted-foreground">{tr('untemplatedReadOnly')}</p>
        {rows.length === 0 ? (
          <p className="rounded-lg border border-dashed border-border px-3 py-6 text-center text-sm text-muted-foreground">
            {tr('untemplatedEmpty')}
          </p>
        ) : (
          /* Wide content scrolls inside its own box — the page body never scrolls sideways. */
          <div className="overflow-x-auto">
            <table className="w-full min-w-[46rem] text-left text-sm">
              <thead>
                <tr className="border-b border-border text-xs uppercase tracking-wide text-muted-foreground">
                  <th className="px-2 py-2 font-medium">{t('company')}</th>
                  <th className="px-2 py-2 font-medium">{t('ruleName')}</th>
                  <th className="px-2 py-2 font-medium">{t('leaveType')}</th>
                  <th className="px-2 py-2 font-medium">{tr('colScope')}</th>
                  <th className="px-2 py-2 font-medium">{t('chain')}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {rows.map((r) => {
                  const scope = scopeOf(r);
                  return (
                    <tr key={r.id} className="align-top">
                      <td className="px-2 py-2">{r.companyName}</td>
                      <td className="px-2 py-2 text-muted-foreground">{r.ruleName ?? '—'}</td>
                      {/* A null leave type is the company-wide wildcard, not a missing value — naming it
                          "Any" is what the old matrix did and what `ruleMatches` actually means. */}
                      <td className="px-2 py-2">{r.leaveTypeName ?? t('anyScope')}</td>
                      <td className="px-2 py-2">
                        {scope.length === 0 ? (
                          <span className="text-muted-foreground">{tr('scopeAllEmployees')}</span>
                        ) : (
                          <ul className="flex flex-wrap gap-1">
                            {scope.map((chip) => (
                              <li
                                key={chip}
                                className="rounded-full bg-muted px-2 py-0.5 text-xs text-foreground"
                              >
                                {chip}
                              </li>
                            ))}
                          </ul>
                        )}
                      </td>
                      <td className="px-2 py-2">
                        {r.levels.length === 0 ? (
                          /* `decideApproval` falls through to the org-wide default (then the built-in
                             chain) when the winning rule's effective chain resolves empty — said out
                             loud, because a blank cell reads as "nobody approves this". */
                          <span className="text-xs text-muted-foreground">{tr('chainEmptyFallback')}</span>
                        ) : (
                          <ChainSteps levels={r.levels} labels={labels} />
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </Card>
  );
}

// ────────────────────────────────────────────────────────────────────────────────────────────────────
// 2. Tab 5's read-out — which chain reaches THIS leave type, and why
// ────────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Everything tab 5 needs for every leave type, READ ONCE for the whole page.
 *
 * `loadApprovalRuleSet(tx)` with no company id reads the tenant's active rules and templates in two
 * queries — the shape the approval replay uses precisely so the round-trip count is CONSTANT in the size
 * of the grid it resolves. A read per (leave type × company) here would be one page render costing
 * `types × companies × 2` queries.
 */
export type LeaveTypeApprovalReadoutData = {
  companies: { id: string; name: string }[];
  set: ApprovalRuleSet;
  templateNameById: Map<string, string>;
  escalationByCompany: Map<string, LeaveEscalationPolicy>;
};

export async function loadLeaveTypeApprovalReadout(
  s: SessionContext,
  companies: { id: string; name: string }[],
): Promise<LeaveTypeApprovalReadoutData> {
  const [set, templates, escalations] = await Promise.all([
    withTenant(s, (tx) => loadApprovalRuleSet(tx)),
    listApprovalTemplates(s),
    Promise.all(
      companies.map(async (c) => [c.id, await getLeaveEscalationPolicy(s, c.id)] as const),
    ),
  ]);
  return {
    companies,
    set,
    templateNameById: new Map(templates.map((x) => [x.id, x.name])),
    escalationByCompany: new Map(escalations),
  };
}

/**
 * TAB 5 — the read-out Round 2 deferred (IA §2.2). It answers "which chain reaches this leave type, and
 * why", per company: the flow that wins today, where that flow came from, its ordered steps, the
 * escalation that chases it, and how many other rules can send a particular employee somewhere else.
 *
 * ⚠️ READ-ONLY, AND THAT IS THE DESIGN, NOT A SHORTFALL. `e4238594` removed a per-leave-type Approval
 * Workflow sub-step from this exact panel because it was a second editor over the same
 * `leave_approval_policy` rows the Approval screen creates. This is not that sub-step coming back: every
 * control that would CHANGE a chain lives on Approval chains, and the link below goes there. The
 * reporter also rejected replacing that sub-step with a bare link or a placeholder — so this is an
 * ANSWER, not a signpost.
 *
 * ⚠️ THE `{}` ATTRS ARE MEANINGFUL. `decideApproval` with no attributes resolves the chain for a
 * requester whose business unit / department / position / grade / grade group / employment type match no
 * scoped rule and whose request carries no day count — i.e. the chain this leave type reaches BEFORE any
 * narrower rule bites. The narrower ones are counted rather than silently averaged into one answer,
 * because a per-employee answer needs an employee and this tab has none.
 */
export async function LeaveTypeApprovalReadout({
  data,
  leaveTypeId,
}: {
  data: LeaveTypeApprovalReadoutData;
  leaveTypeId: string;
}) {
  const t = await getTranslations('leaveApproval');
  const tr = await getTranslations('admin.leaveConfigApprovalChains');
  const labels = Object.fromEntries(
    (Object.keys(LEVEL_LABEL_KEY) as LeaveLevelKind[]).map((k) => [k, t(LEVEL_LABEL_KEY[k])]),
  ) as Record<LeaveLevelKind, string>;

  const rows = data.companies.map((c) => {
    // THE one matcher, over a rule set read once. Nothing here ranks, filters or scores a rule.
    const decision = decideApproval(data.set, c.id, leaveTypeId);
    const rules = data.set.rulesByCompany.get(c.id) ?? [];
    const winner = decision.ruleId === null ? null : (rules.find((r) => r.id === decision.ruleId) ?? null);
    const templateName =
      winner?.templateId == null ? null : (data.templateNameById.get(winner.templateId) ?? null);
    // Every OTHER active rule in this company that could apply to this leave type (its own type, or the
    // company-wide wildcard). Each one carries at least one narrowing dimension — a second fully-wildcard
    // row for the same company + leave type is forbidden by `leave_approval_policy_wildcard_uq` — so each
    // one genuinely can win for some employee, or for some day count, and change the answer above.
    const others = rules.filter(
      (r) => (r.leaveTypeId === null || r.leaveTypeId === leaveTypeId) && r.id !== decision.ruleId,
    ).length;
    return { company: c, decision, templateName, others, esc: data.escalationByCompany.get(c.id) ?? null };
  });

  return (
    /* The tab-5 half of the same render probe — see the note on the list above. Tab 5's markup is not in
       the first paint (the panel opens on tab 1), so the probe is what a browser check asserts AFTER
       clicking through to the tab. */
    <div className="space-y-1.5" data-readout="leave-type-approval-chain">
      <span className="text-xs font-medium text-muted-foreground">{tr('readoutTitle')}</span>
      <div className="space-y-2 rounded-lg bg-background p-3">
        <p className="text-xs text-muted-foreground">{tr('readoutHint')}</p>
        {rows.length === 0 ? (
          <p className="text-xs text-muted-foreground">{t('emptyScope')}</p>
        ) : (
          <ul className="divide-y divide-border">
            {rows.map(({ company, decision, templateName, others, esc }) => (
              <li key={company.id} className="space-y-1.5 py-2 first:pt-0 last:pb-0">
                <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
                  <span className="text-sm font-medium">{company.name}</span>
                  <span className="text-xs text-muted-foreground">
                    {decision.source === 'rule'
                      ? templateName
                        ? tr('sourceTemplate', { name: templateName })
                        : tr('sourceRule')
                      : decision.source === 'tenant-default'
                        ? tr('sourceTenantDefault')
                        : tr('sourceFallback')}
                  </span>
                </div>
                <ChainSteps levels={decision.levels} labels={labels} />
                <p className="text-xs text-muted-foreground">
                  {esc?.enabled && esc.escalateAfterDays !== null
                    ? tr('escalationOn', {
                        days: esc.escalateAfterDays,
                        target:
                          esc.target === 'specific_role' && esc.targetRole
                            ? labels[esc.targetRole]
                            : t('escalationNextLevel'),
                      })
                    : tr('escalationOff')}
                </p>
                {others > 0 && <p className="text-xs text-muted-foreground">{tr('otherRules', { n: others })}</p>}
              </li>
            ))}
          </ul>
        )}
        {/* The ONE navigation direction the preview module has, resolved through the map so the link and
            the menu cannot give two answers about where Approval chains lives (r259 finding 3). */}
        <Link href={leaveConfigScreenHref('approvalChain')} className="inline-block text-xs underline">
          {tr('readoutManageLink')}
        </Link>
      </div>
    </div>
  );
}
