import Link from 'next/link';
import { getTranslations } from 'next-intl/server';

import { listEmployees } from '@/core/read';
import { entitlementExplainFactsFor } from '@/core/entitlement-scheme-view';
import type { SessionContext } from '@/db/client';
import {
  explainEntitlementEligibilityFor,
  eligibilityNoticeFrom,
  type EntitlementWinReason,
} from '@/packs/leave/service';
import { Card, SectionHeader, btnPrimary, inputCls } from '@/components/ui';
import { leaveConfigScreenHref } from '@/components/leave-config-map';
import {
  eligibilityExplainSentence,
  type EligibilityNotice,
  type EligibilityRuleNotice,
} from '@/lib/entitlement-status';
import { summariseOrgCriteria, type CriteriaAxisSummary } from '@/lib/entitlement-criteria-summary';
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

/**
 * r270 (65e4073a build 3) — WHY THE WINNER BEAT THE RUNNER-UP, AS ONE SENTENCE EACH.
 *
 * Two schemes that each narrow by one axis TIE on `orgCriteriaSpecificity` and are then separated by
 * `validFrom`, and if that ties too by `createdAt` — silently, with nothing on screen. The engine now
 * reports which term decided (`winReasonFor`, core/entitlement-template.ts) and this maps it to words.
 *
 * `sole_candidate` maps to NULL on purpose: only one scheme reached this employee, so there is no
 * comparison to narrate and a line claiming one would be furniture at best. The `later_created` case
 * shares `explainWhyChosenLater` with `later_start` and selects a different wording inside it — the start
 * dates are identical there, so "it starts later" would be false about the configuration on screen.
 */
const WHY_CHOSEN_KEY: Record<EntitlementWinReason, string | null> = {
  sole_candidate: null,
  more_specific: 'explainWhyChosenSpecific',
  later_start: 'explainWhyChosenLater',
  later_created: 'explainWhyChosenLater',
};

/** How many option names one axis contributes to the "(job grade 16-19, full time)" clause before the
 *  rest become a count. The Covers column's cap, for the same reason: a 66-row grade catalogue is not a
 *  sentence. */
const CLAUSE_VALUE_CAP = 6;

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
   * ⚠️ ONLY A LINEAGE WITH A RUNNING VERSION IS LINKABLE. `?editRule=` is answered by the entitlement
   * tables block, which looks the lineage up in its RUNNING rules — so a link on an expired or retired
   * lineage navigates, loses the explanation, and opens nothing. Those are precisely the rules a reader
   * most wants to click, which is why this returns null for them rather than rendering a link that does
   * nothing. The predicate is the block's own (`rules.filter((x) => x.validTo == null)`), restated here
   * because this panel holds the unscoped list.
   */
  const runningRuleLineages = new Set(data.rules.filter((r) => r.validTo == null).map((r) => r.lineageId));

  /**
   * r270 (995387c6) — THE RULE EDITOR IS ON THE LEAVE TYPES SCREEN NOW, AND THIS LINK HAD TO FOLLOW IT.
   *
   * This panel used to send "Open scheme" back to its OWN address with `&editRule=`, because the
   * Entitlement tables screen mounted the block unscoped and answered that parameter. This round removes
   * the Benefit schemes section from that screen, so the parameter would arrive at a route that no longer
   * reads it: a control that navigates, loses the explanation and opens nothing — the exact failure the
   * `runningRuleLineages` gate above exists to prevent, arriving by a different door.
   *
   * VERIFIED, not assumed: `app/admin/leave-config/types/page.tsx` declares `editRule` in its
   * `searchParams` and passes it into every per-type `EntitlementTablesBlock` mount, and that block
   * resolves it against its running rules and renders the rule editor. One contract, two mounts.
   *
   * ⚠️ THE `#type-<id>` ANCHOR IS LOAD-BEARING, and the block's own header says why: `LeaveTypeWorkspace`
   * seeds its selection from `items[0]` and only then applies the hash, so a hard load with no anchor
   * lands on the FIRST leave type alphabetically while the rule being edited belongs to another. The
   * anchor is the deep-link contract every Edit link in that block already carries.
   *
   * WHAT IS LOST, stated rather than papered over: the explain query no longer rides along, because the
   * destination is a different screen and would ignore it. The browser's Back returns to the explanation
   * intact — it is a GET form, so the address still holds the whole question.
   */
  const ruleEditorHref = (lineageId: string) =>
    `${leaveConfigScreenHref('leaveTypes')}?editRule=${encodeURIComponent(lineageId)}` +
    `#type-${encodeURIComponent(leaveTypeId)}`;

  const explanation =
    chosen && leaveTypeId
      ? await explainEntitlementEligibilityFor(s, {
          employmentId: chosen.employmentId,
          leaveTypeId,
          asOf,
        })
      : null;
  const notice = explanation
    ? eligibilityNoticeFrom(explanation, {
        href: (lineageId) => (runningRuleLineages.has(lineageId) ? ruleEditorHref(lineageId) : null),
      })
    : null;

  /**
   * r270 (65e4073a build 2) — THE REST OF THE SENTENCE, FROM FACTS THAT ARE ALREADY COMPUTED.
   *
   * Asked ONLY when something actually resolved: with no winner there are no days to explain, the panel's
   * verdict line is the whole answer, and this query would be paid for nothing. The bands handed in are
   * the WINNER'S own (`ResolvedEntitlement.serviceBands`), so the band named on screen is chosen from the
   * very array the engine resolved — `entitlementExplainFactsFor` selects it through the engine's
   * `bandFor` and never re-derives one.
   */
  const facts =
    chosen && explanation?.winner
      ? await entitlementExplainFactsFor(s, {
          employmentId: chosen.employmentId,
          asOf,
          serviceBands: explanation.winner.serviceBands,
        })
      : null;
  /** The notice plus the four employee-side facts — the shape `eligibilityExplainSentence` reads. */
  const noticeWithFacts: EligibilityNotice | null = notice
    ? {
        ...notice,
        gradeName: facts?.gradeName ?? null,
        serviceYears: facts?.serviceYears ?? null,
        winningBand: facts?.band ?? null,
        daysAtService: facts?.daysAtService ?? null,
      }
    : null;

  /**
   * "(job grade 16-19, full time)" — the WINNING rule's criteria in the picker's own words.
   *
   * ⚠️ THE SAME SUMMARISER THE COVERS COLUMNS USE (`lib/entitlement-criteria-summary.ts`), not a third
   * rendering of one criteria object. Its header states the rule: two renderings of the same object
   * eventually disagree on two halves of one screen. It also never prints a raw UUID — an archived
   * catalogue row has no option to name it, so it is COUNTED — which is the property this clause needs
   * most, since the commonest axis here is `gradeIds` and its stored values are ids.
   *
   * The VERSION matched is the one in force at `asOf`, by the resolver's own predicate, so the criteria
   * quoted are the criteria that decided rather than whatever the lineage's head happens to say today.
   */
  const winningRuleVersion =
    explanation?.winner?.ruleLineageId != null
      ? (data.rules.find(
          (r) =>
            r.lineageId === explanation.winner!.ruleLineageId &&
            r.validFrom <= asOf &&
            (r.validTo == null || r.validTo > asOf),
        ) ?? null)
      : null;
  const criteriaClause = winningRuleVersion
    ? summariseOrgCriteria(winningRuleVersion.criteria as Record<string, unknown>, data.criteriaSections)
        .map((a: CriteriaAxisSummary) => {
          if (a.scalar != null) return `${a.label}: ${a.scalar}`;
          const shown = a.values.slice(0, CLAUSE_VALUE_CAP);
          const hidden = a.values.length - shown.length + a.unresolved;
          if (shown.length === 0) return null;
          return `${a.label}: ${shown.join(' · ')}${hidden > 0 ? ` ${t('coversMore', { count: hidden })}` : ''}`;
        })
        .filter((x): x is string => x != null)
        .join('; ')
    : null;

  /** Null for every verdict where nothing resolved — see `eligibilityExplainSentence`'s header. */
  const sentence =
    noticeWithFacts && chosen
      ? eligibilityExplainSentence(noticeWithFacts, { employee: chosen.name, criteriaClause })
      : null;

  /** The lineage that actually won, so the why-chosen line lands on ONE row. Keyed on the lineage id and
   *  never on the name: several rules can be `matched`, and nothing makes two rule names differ. */
  const winningLineageId = explanation?.winner?.ruleLineageId ?? null;
  const whyChosenKey = explanation?.winner?.winReason
    ? WHY_CHOSEN_KEY[explanation.winner.winReason]
    : null;
  /** The runner-up this win is stated against — `alsoMatched` is ranked, so its first entry is it. */
  const runnerUpName = explanation?.winner?.alsoMatched[0]?.ruleName ?? '';

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
            {/* r270 (65e4073a build 2) — THE WHOLE SENTENCE, UNDER THE ONE-LINE VERDICT.
                "Ahmad is Grade 17 with 7 years of service. The scheme GP1215 (Job Grade: Grade 16 · …)
                covers them, and its table GP1215 gives 20 days for 5 or more years of service."
                Every figure in it was already computed by the engine — nothing new is stored, nothing is
                recalculated and no model is involved (CLAUDE.md §1: the LLM never computes money, and
                entitlement days are encashable). Absent when nothing resolved: the verdict above is then
                the whole answer, and a sentence about days that do not exist would be worse than silence. */}
            {sentence ? <p className="text-sm">{t(sentence.key, sentence.values)}</p> : null}
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
                            <>
                              {t('explainWhyMatched')}
                              {/* r270 (65e4073a build 3) — AND, ON THE ROW THAT ACTUALLY WON, WHY IT WON.
                                  Several rules can read "Matches" (the engine tests them all); exactly one
                                  of them decided, and until now the ranking that picked it was invisible.
                                  Rendered only where there was a comparison to report — `WHY_CHOSEN_KEY`
                                  maps the single-candidate case to null. */}
                              {r.id === winningLineageId && whyChosenKey ? (
                                <span className="block text-muted-foreground">
                                  {t(whyChosenKey, {
                                    other: runnerUpName,
                                    date: r.validFrom,
                                    basis:
                                      explanation?.winner?.winReason === 'later_start' ? 'start' : 'created',
                                  })}
                                </span>
                              ) : null}
                            </>
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
