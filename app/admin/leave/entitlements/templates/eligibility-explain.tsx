import Link from 'next/link';
import { getTranslations } from 'next-intl/server';

import { listEmployees } from '@/core/read';
import type { SessionContext } from '@/db/client';
import { explainEntitlementEligibilityFor, eligibilityNoticeFrom } from '@/packs/leave/service';
import { Card, SectionHeader, btnPrimary, inputCls } from '@/components/ui';
import type { EligibilityRuleNotice } from '@/lib/entitlement-status';
import { criteriaAxisLabeller, criteriaValueLabeller } from './leave-type-conditions';
import type { EntitlementTablesData } from './entitlement-tables-block';

/**
 * r212 (8ebf77ae) — "NO ELIGIBILITY RULE REACHES YOU", ANSWERED FOR A NAMED EMPLOYEE.
 *
 * THE ORIGINAL TICKET, and the half that was still unbuilt. r209 gave the employee's own panel a status
 * (`no_eligibility_match`) that says WHAT happened; it could never say WHICH rule, because a status is one
 * word and the reasons are a list. This is the list, on the screen where the rules are configured — HR is
 * looking at the rules and asks "so why does Ali get nothing?", and the answer is one search away instead
 * of a reading of six rule rows against one employee record.
 *
 * ⚠️ NOTHING HERE MATCHES ANYBODY. Every judgement comes from `explainEntitlementEligibility`
 * (core/entitlement-template.ts), which is itself the resolver's own `resolveOrgCriteriaTargets` calls
 * asked again — the winner through the existing single-employee delegate, the failing axis through the same
 * predicate over a one-axis subset of the same criteria. This file resolves LABELS and renders sentences.
 *
 * ⚠️ IT READS THE EMPLOYEE LIST ONLY WHEN SOMEBODY SEARCHES. The list is unbounded (a tenant has thousands)
 * and this panel sits on a configuration screen that already runs fourteen reads; a picker rendered on every
 * load would put the whole directory into the HTML of a page nobody opened it for. So the search box posts a
 * string, the matches are cut to `MAX_MATCHES`, and a load with no `q` costs nothing.
 *
 * ⚠️ THE STANDALONE SCREEN ONLY, not the block that is mounted twice. The Entitlements page composes a panel
 * for every leave type up front, so anything added to `EntitlementTablesBlock` is rendered ~24 times per
 * load. An employee search is not a per-leave-type control.
 *
 * SERVER COMPONENT, no client island: everything is a GET form and links. Substrate: read-only, no event.
 */

/** How many search hits are listed. Enough to recognise a colleague, few enough that nobody scrolls. */
const MAX_MATCHES = 20;

export type EligibilityExplainParams = {
  explainQ?: string;
  explainEmployment?: string;
  explainLeaveType?: string;
  explainAsOf?: string;
};

/** The five rule states as one sentence each — the same five `EligibilityRuleNotice['state']` carries, so
 *  the admin explanation and the employee's own panel describe one configuration in one vocabulary. */
const STATE_KEY: Record<EligibilityRuleNotice['state'], string> = {
  matched: 'explainStateMatched',
  in_force: 'explainStateInForce',
  expired: 'explainStateExpired',
  not_yet: 'explainStateNotYet',
  table_stopped: 'explainStateTableStopped',
};

export async function EligibilityExplainPanel({
  s,
  data,
  params,
}: {
  s: SessionContext;
  data: EntitlementTablesData;
  params: EligibilityExplainParams;
}) {
  const t = await getTranslations('admin.entitlementTemplates');

  const q = (params.explainQ ?? '').trim();
  const asOf = /^\d{4}-\d{2}-\d{2}$/.test(params.explainAsOf ?? '') ? params.explainAsOf! : data.today;
  // Archived types configure nothing and grant nothing — offering one here would invite an explanation of
  // a leave type nobody can be granted, which is the "permanent red row" the health card refuses too.
  const typeOptions = data.leaveTypes.filter((x) => !x.archived);
  const leaveTypeId =
    typeOptions.find((x) => x.id === params.explainLeaveType)?.id ?? typeOptions[0]?.id ?? '';

  // ONE query, and only behind a search — see the header.
  const matches = q
    ? (await listEmployees(s))
        .filter((e) =>
          [e.name, e.employeeCode ?? '', e.email ?? ''].some((f) => f.toLowerCase().includes(q.toLowerCase())),
        )
        .slice(0, MAX_MATCHES + 1)
    : [];
  const shown = matches.slice(0, MAX_MATCHES);
  const chosen = shown.find((e) => e.employmentId === params.explainEmployment) ?? null;

  /** Carry the current selection through a link without losing the search that produced it. */
  const linkFor = (employmentId: string) =>
    `?explainQ=${encodeURIComponent(q)}&explainEmployment=${encodeURIComponent(employmentId)}` +
    `&explainLeaveType=${encodeURIComponent(leaveTypeId)}&explainAsOf=${encodeURIComponent(asOf)}`;

  // The SAME labels the rule editor's own pickers carry, for BOTH halves of "does not match X: yours is Y"
  // — derived, never a second list (see leave-type-conditions.ts). The inherited-conditions block on this
  // same screen labels the identical vocabulary through the identical two functions.
  const axisLabel = criteriaAxisLabeller(data.criteriaSections);
  const valueLabel = criteriaValueLabeller(data.criteriaSections);

  /**
   * ⚠️ ONLY A LINEAGE WITH A RUNNING VERSION IS LINKABLE. `?editRule=` is answered by the block above,
   * which looks the lineage up in its RUNNING rules — so a link on an expired or retired lineage navigates,
   * loses the explanation, and opens nothing. Those are precisely the rules a reader most wants to click,
   * which is why this returns null for them rather than rendering a link that does nothing.
   */
  const runningRuleLineages = new Set(data.rules.filter((r) => r.validTo == null).map((r) => r.lineageId));

  const notice =
    chosen && leaveTypeId
      ? eligibilityNoticeFrom(
          await explainEntitlementEligibilityFor(s, {
            employmentId: chosen.employmentId,
            leaveTypeId,
            asOf,
          }),
          {
            // …and the answer is carried THROUGH the link, so opening a rule does not throw away the
            // employee, the leave type and the date that produced the question.
            href: (lineageId) =>
              runningRuleLineages.has(lineageId)
                ? `${linkFor(chosen.employmentId)}&editRule=${encodeURIComponent(lineageId)}`
                : null,
          },
        )
      : null;
  const typeName = typeOptions.find((x) => x.id === leaveTypeId)?.name ?? '';

  return (
    <Card>
      <SectionHeader title={t('explainTitle')} />
      <div className="space-y-3 p-4">
        <p className="text-xs text-muted-foreground">{t('explainHelp')}</p>

        {/* A GET form: the whole panel is addressable, so an answer can be sent to somebody as a link. */}
        <form method="get" className="grid items-end gap-3 sm:grid-cols-4">
          <label className="flex flex-col gap-1 text-xs text-muted-foreground sm:col-span-2">
            {t('explainSearchLabel')}
            <input className={inputCls} name="explainQ" defaultValue={q} />
          </label>
          <label className="flex flex-col gap-1 text-xs text-muted-foreground">
            {t('explainLeaveType')}
            <select className={inputCls} name="explainLeaveType" defaultValue={leaveTypeId}>
              {typeOptions.map((x) => (
                <option key={x.id} value={x.id}>
                  {x.name}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1 text-xs text-muted-foreground">
            {t('explainAsOf')}
            <input className={inputCls} type="date" name="explainAsOf" defaultValue={asOf} />
          </label>
          {/* The chosen employee rides along so changing the date or the leave type re-explains the SAME
              person rather than dropping the answer and asking for the search again. */}
          {chosen ? <input type="hidden" name="explainEmployment" value={chosen.employmentId} /> : null}
          <div className="sm:col-span-4">
            <button type="submit" className={btnPrimary}>
              {t('explainSearchButton')}
            </button>
          </div>
        </form>

        {q && shown.length === 0 ? <p className="text-xs text-muted-foreground">{t('explainNoMatches', { q })}</p> : null}
        {shown.length > 0 ? (
          <ul className="flex flex-wrap gap-x-3 gap-y-1 text-xs">
            {shown.map((e) => (
              <li key={e.employmentId}>
                <Link
                  href={linkFor(e.employmentId)}
                  className={e.employmentId === chosen?.employmentId ? 'font-medium underline' : 'underline'}
                >
                  {e.employeeCode ? `${e.name} (${e.employeeCode})` : e.name}
                </Link>
              </li>
            ))}
          </ul>
        ) : null}
        {matches.length > MAX_MATCHES ? (
          <p className="text-xs text-muted-foreground">{t('explainMatchesMore', { count: MAX_MATCHES })}</p>
        ) : null}

        {notice && chosen ? (
          <div className="space-y-2 rounded-md border border-border p-3">
            <p className="text-xs text-muted-foreground">
              {t('explainFor', { employee: chosen.name, type: typeName, date: asOf })}
            </p>
            {/* THE ANSWER FIRST. A reader who came here because a balance reads 0.00 needs the verdict
                before the working — and the verdict is the SHARED one (`eligibilityNoticeFrom`), not this
                screen's own reading of the same fields. Both screens once re-derived it here and duly
                disagreed about the same employee; see that function's header. */}
            <p className="text-sm">
              {notice.verdict === 'sole_table'
                ? t('explainWinnerSole', { table: notice.winningTableName ?? '' })
                : /* 76ffdcf2 — the fourth verdict: no scheme reached this employee and the leave type's
                     DEFAULT table answered. Named on its own rather than folded into `resolved`, whose
                     sentence interpolates a rule name that does not exist here. */
                  notice.verdict === 'default_table'
                  ? t('explainWinnerDefault', { table: notice.winningTableName ?? '' })
                  : notice.verdict === 'resolved'
                    ? t('explainWinner', {
                        table: notice.winningTableName ?? '',
                        rule: notice.winningRuleName ?? '',
                      })
                    : notice.verdict === 'not_active'
                      ? t('explainNotActive', { date: asOf })
                      : t('explainNoWinner')}
            </p>
            {/* …and the employment window as a CAVEAT rather than a competing verdict, for the one case
                where both are true: a sole table resolves for somebody outside their employment window,
                because that shortcut deliberately consults no window (r193 fault 3). */}
            {notice.activeAtDate || notice.verdict === 'not_active' ? null : (
              <p className="text-xs text-muted-foreground">{t('explainNotActive', { date: asOf })}</p>
            )}

            {notice.verdict === 'no_rules' || notice.rules.length === 0 ? (
              <p className="text-xs text-muted-foreground">{t('explainNoRules')}</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-left text-xs">
                  <thead className="bg-muted/40 uppercase text-muted-foreground">
                    <tr>
                      <th className="px-2 py-1.5">{t('explainColRule')}</th>
                      <th className="px-2 py-1.5">{t('explainColStatus')}</th>
                      <th className="px-2 py-1.5">{t('explainColWhy')}</th>
                      <th className="px-2 py-1.5" />
                    </tr>
                  </thead>
                  <tbody>
                    {notice.rules.map((r) => (
                      /* KEYED ON THE LINEAGE, never on the name: nothing makes two rule names differ, and
                         two rows sharing a React key render as one. */
                      <tr key={r.id} className="border-t align-top">
                        <td className="px-2 py-1.5">
                          <span className="font-medium">{r.name}</span>
                          {r.tableName ? (
                            <span className="block text-muted-foreground">{t('explainTable', { name: r.tableName })}</span>
                          ) : null}
                        </td>
                        <td className="px-2 py-1.5">
                          {t(STATE_KEY[r.state], { date: r.validTo ?? r.validFrom })}
                        </td>
                        <td className="px-2 py-1.5">
                          {/* ⚠️ "NOT TESTED" IS DECIDED BY `tested`, NOT BY THE STATE. A rule can be
                              perfectly in force and still never have been compared against this employee —
                              when the employment did not exist on the date, nothing below the employment
                              window is consulted. Reading the state instead left "In force" beside an empty
                              cell for every rule on that screen, which invites a hunt for a criterion that
                              was never looked at. */}
                          {r.state === 'matched' ? (
                            t('explainWhyMatched')
                          ) : !r.tested ? (
                            t('explainWhyNotTested')
                          ) : r.failingAxis ? (
                            (() => {
                              // Labelled through the SAME vocabulary the inherited-conditions block on this
                              // screen uses — an axis the vocabulary cannot name is named not at all.
                              const axis = axisLabel(r.failingAxis);
                              if (!axis) return r.failsOnCombination ? t('explainWhyCombination') : '';
                              return r.failingAxisValue
                                ? t('explainWhyAxis', {
                                    axis,
                                    value: valueLabel(r.failingAxis, r.failingAxisValue),
                                  })
                                : t('explainWhyAxisNoValue', { axis });
                            })()
                          ) : r.failsOnCombination ? (
                            t('explainWhyCombination')
                          ) : (
                            ''
                          )}
                        </td>
                        <td className="px-2 py-1.5">
                          {r.href ? (
                            <Link href={r.href} className="underline">
                              {t('explainRuleLink')}
                            </Link>
                          ) : null}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {/* AGENTS 28's spirit: say what the data cannot support. `UNDATED_ELIGIBILITY_AXES` are read at
                TODAY'S value however far back `asOf` reaches — a schema fact, not a choice made here. */}
            {notice.usesUndatedAxis ? (
              <p className="text-xs text-muted-foreground">{t('ruleUndatedAxesNote')}</p>
            ) : null}
          </div>
        ) : null}
      </div>
    </Card>
  );
}
