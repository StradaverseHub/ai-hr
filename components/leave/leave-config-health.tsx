import { getTranslations } from 'next-intl/server';

import {
  isBlockingFinding,
  tablesReachNobody,
  type LeaveConfigFinding,
  type LeaveConfigHealth,
} from '@/lib/leave-config-health';
import { Card, SectionHeader } from '@/components/ui';
// r224 — day figures print through the shared formatter, so the range this line quotes matches the table
// rows it is quoting from, digit for digit (4a1abc4a).
import { formatDays } from '@/lib/day-format';

/**
 * r209 — THE CAUSES, ON THE SCREEN, INSTEAD OF IN THE DATABASE.
 *
 * Every fact this renders was already recorded and read by nothing: `leave_type.accrual_unconfigured` was
 * stamped 2026-08-04 on four leave types, and the tenant's ONE eligibility rule carried
 * `valid_to = 2026-08-13`, after which no employee resolved to any entitlement table. Both were silent, so
 * a whole tenant's leave balances read 0.00 for six days with nothing to look at.
 *
 * TWO MOUNTS, ONE DEFINITION, exactly as `EntitlementTablesBlock` next door has:
 *   - `LeaveConfigHealthCard` — every active leave type at a glance, on the Entitlements page. This is the
 *     "one page Leave Balance Health check with a traffic light" the approved plan describes.
 *   - `LeaveConfigHealthNotice` — ONE type's findings, inside its own Entitlement step, beside the tables
 *     the findings are about. A warning on a different screen from the thing it is about gets ignored.
 * Both render `renderFindings` below, so the wording of "no eligibility rule points at this table" cannot
 * come to differ between the summary and the detail.
 *
 * ⚠️ EVERY FINDING NAMES WHAT IT IS ABOUT. "Some tables have no rule" is not actionable; "no eligibility
 * rule points at: Contract Grade 19 and above, Contract Retiree" is. The derivation carries the names for
 * exactly this reason and this file must not reduce them to counts.
 *
 * ⚠️ IT REPORTS; IT NEVER FIXES. A Maximum Balance of 0 is announced as a cap of 0 — the semantics in
 * `core/leave-compute.ts` (any finite number >= 0 is a real cap) are deliberate and untouched here.
 *
 * SERVER COMPONENT. No client island, no props crossing a boundary — the whole thing is text derived from
 * plain data, and `test/server-client-boundary.test.ts` is the reason that is worth saying out loud.
 */

const STATUS_TONE: Record<LeaveConfigHealth['status'], string> = {
  blocked:
    'border-red-300 bg-red-50 text-red-900 dark:border-red-800/60 dark:bg-red-950/40 dark:text-red-200',
  warning:
    'border-amber-300 bg-amber-50 text-amber-900 dark:border-amber-700/60 dark:bg-amber-950/40 dark:text-amber-200',
  ready:
    'border-emerald-300 bg-emerald-50 text-emerald-900 dark:border-emerald-800/60 dark:bg-emerald-950/40 dark:text-emerald-200',
};

/** The i18n leaf under `admin.entitlementTemplates` for each traffic-light state. */
const STATUS_LABEL_KEY: Record<LeaveConfigHealth['status'], string> = {
  blocked: 'healthStatusBlocked',
  warning: 'healthStatusWarning',
  ready: 'healthStatusReady',
};

type T = Awaited<ReturnType<typeof getTranslations<'admin.entitlementTemplates'>>>;

/**
 * One finding as a sentence naming what it is about.
 *
 * A `switch` rather than a key map because every branch takes DIFFERENT parameters — the ones that name
 * tables interpolate a list, `no_rule_in_force` interpolates a count. A map of bare keys would have to drop
 * the parameters, and a finding without its names is a finding nobody can act on. It also keeps every key
 * STATIC, which is what `test/i18n-coverage.test.ts`'s case C can actually check.
 */
function findingText(t: T, h: LeaveConfigHealth, f: LeaveConfigFinding): string {
  const list = (names: string[]) => names.join(', ');
  switch (f) {
    case 'no_earning_method':
      return t('healthNoEarningMethod');
    case 'no_entitlement_table':
      return t('healthNoEntitlementTable');
    case 'no_rule_in_force':
      return t('healthNoRuleInForce', { tables: h.templateCount });
    case 'table_without_rule':
      return t('healthTableWithoutRule', { tables: list(h.tablesWithoutRule) });
    case 'rule_expired':
      return t('healthRuleExpired', {
        rules: list(h.expiredRules.map((r) => `${r.name} (${r.endedOn})`)),
      });
    case 'rule_expiring':
      return t('healthRuleExpiring', {
        rules: list(h.expiringRules.map((r) => `${r.name} (${r.endsOn})`)),
      });
    case 'grades_without_table':
      return t('healthGradesWithoutTable', { grades: list(h.gradesWithoutTable) });
    case 'max_balance_zero':
      return t('healthMaxBalanceZero', { tables: list(h.zeroMaxBalanceTables) });
  }
}

/** The findings of one leave type, blocking ones first — they are the reason the figure is 0.00 today. */
function FindingList({ t, h }: { t: T; h: LeaveConfigHealth }) {
  const ordered = [...h.findings].sort((a, b) => Number(isBlockingFinding(b)) - Number(isBlockingFinding(a)));
  if (ordered.length === 0) return <span className="text-xs text-muted-foreground">{t('healthNothingMissing')}</span>;
  return (
    <ul className="space-y-0.5">
      {ordered.map((f) => (
        <li key={f} className="text-xs">
          <span className={isBlockingFinding(f) ? 'font-medium' : undefined}>{findingText(t, h, f)}</span>
        </li>
      ))}
    </ul>
  );
}

/**
 * r224 — WHAT YOU CONFIGURED, BESIDE WHAT IS ACTUALLY GRANTED, on the leave types where those two are not
 * the same number.
 *
 * The reporter's account has sixteen Annual Leave tables specifying 12 to 24 days and no eligibility rule,
 * and every screen in the product showed the first of those figures. Nothing showed the second. The
 * findings list above already says nobody can receive the tables; this line says what that COSTS, which is
 * the sentence that makes it urgent rather than tidy.
 *
 * ⚠️ THE "ACTUALLY GRANTED" FIGURE IS 0.00, AND IT IS NOT A GUESS. With no eligibility rule in force
 * `buildTemplateEntitlementResolver` resolves no band, `composeEntitlement` returns 0 days with
 * `noOpinion` set, and `openLeaveYear` records the pair as `no_entitlement` and writes no accrual row.
 * It is deliberately NOT described as "the statutory minimum": fa3f4ccb made the Employment Act floor
 * ADVISORY — it is computed for the below-minimum warning and no longer participates in the arithmetic
 * anywhere — so a screen claiming employees receive it would be describing a composition this codebase
 * removed. Whatever days already sit on a record came from an earlier configuration or from a manual
 * adjustment, which is what the sentence says.
 *
 * Rendered ONLY for `tablesReachNobody`, and from the derivation's own predicate rather than a second
 * expression over the same counts.
 */
function ConfiguredVsActual({ t, h }: { t: T; h: LeaveConfigHealth }) {
  if (!tablesReachNobody(h) || h.configuredDaysMin == null || h.configuredDaysMax == null) return null;
  const configured =
    h.configuredDaysMin === h.configuredDaysMax
      ? formatDays(h.configuredDaysMin)
      : `${formatDays(h.configuredDaysMin)}–${formatDays(h.configuredDaysMax)}`;
  return (
    <p className="text-xs font-medium">
      {t('healthConfiguredVsActual', { configured, tables: h.templateCount })}
    </p>
  );
}

function StatusPill({ t, status }: { t: T; status: LeaveConfigHealth['status'] }) {
  return (
    <span
      className={`inline-block whitespace-nowrap rounded-full border px-2 py-0.5 text-[11px] font-medium ${STATUS_TONE[status]}`}
    >
      {t(STATUS_LABEL_KEY[status])}
    </span>
  );
}

/** "Earning method: set · Tables in force: 6 · Rules in force: 0" — the three counts the reporter asked to
 *  see per type, in one line, whether or not anything is wrong with them. */
function HealthCounts({ t, h }: { t: T; h: LeaveConfigHealth }) {
  return (
    <p className="text-xs text-muted-foreground">
      {t('healthCounts', {
        method: h.earningMethodSet ? t('healthMethodSet') : t('healthMethodMissing'),
        tables: h.templateCount,
        rules: h.ruleCount,
      })}
      {h.soleTableApplies ? <span className="ml-1">{t('healthSoleTable')}</span> : null}
    </p>
  );
}

/**
 * ONE leave type, inside its own Entitlement step.
 *
 * Rendered unconditionally, including when the type is healthy: the counts are the answer to "is an earning
 * method set and does anything point at these tables", and a panel that appears only when something is
 * wrong is a panel nobody learns to look at. Only the findings list is conditional on there being any.
 */
export async function LeaveConfigHealthNotice({ health }: { health: LeaveConfigHealth }) {
  const t = await getTranslations('admin.entitlementTemplates');
  return (
    <div className={`space-y-1.5 rounded-lg border p-3 ${STATUS_TONE[health.status]}`}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs font-medium">{t('healthTitle')}</span>
        <StatusPill t={t} status={health.status} />
      </div>
      <HealthCounts t={t} h={health} />
      <FindingList t={t} h={health} />
      <ConfiguredVsActual t={t} h={health} />
    </div>
  );
}

/**
 * EVERY active leave type, on the Entitlements page — the traffic-light listing.
 *
 * Ordered blocked → warning → ready by `leaveConfigHealthAll`, so the types that cannot produce a balance
 * today are the first thing on the card rather than something to scroll for.
 */
export async function LeaveConfigHealthCard({ rows }: { rows: LeaveConfigHealth[] }) {
  const t = await getTranslations('admin.entitlementTemplates');
  const unhealthy = rows.filter((r) => r.status !== 'ready').length;
  return (
    <Card>
      <SectionHeader title={t('healthCardTitle')} count={unhealthy} />
      <div className="space-y-2 px-4 py-3">
        <p className="text-xs text-muted-foreground">{t('healthCardHelp')}</p>
        {rows.length === 0 ? (
          <p className="text-xs text-muted-foreground">{t('healthNoTypes')}</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="bg-muted/40 text-xs uppercase text-muted-foreground">
                <tr>
                  <th className="px-3 py-2">{t('healthColLeaveType')}</th>
                  <th className="px-3 py-2">{t('healthColStatus')}</th>
                  <th className="px-3 py-2">{t('healthColWhatIsMissing')}</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((h) => (
                  <tr key={h.leaveTypeId} className="border-t align-top">
                    <td className="px-3 py-2 font-medium">{h.leaveTypeName}</td>
                    <td className="px-3 py-2">
                      <StatusPill t={t} status={h.status} />
                    </td>
                    <td className="px-3 py-2">
                      <FindingList t={t} h={h} />
                      <ConfiguredVsActual t={t} h={h} />
                      <HealthCounts t={t} h={h} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </Card>
  );
}
