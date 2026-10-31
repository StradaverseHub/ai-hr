import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { requireAdmin } from '@/lib/authz';
import {
  DUPLICATE_EVIDENCE_FIELDS,
  DUPLICATE_FIELD_NOT_A_CONTRADICTION,
  IC_VERDICTS_INDICATING_ONE_PERSON,
  duplicatePersonCandidates,
  type DuplicateEvidenceField,
} from '@/core/duplicate-person';
import { Card, EmployeeCode, PageHeader, SectionHeader, pageWideCls, tableWrapCls, tbodyCls, theadCls, thCls } from '@/components/ui';

/**
 * 05d2709a — POSSIBLE DUPLICATE EMPLOYEE RECORDS. The screen the reporter judges pairs from.
 *
 * ═══ ⚠️ IT SHOWS EVIDENCE. IT NEVER SHOWS A SCORE. ═══
 *
 * "Same name, same joining date" is a heuristic: it misses a duplicate typed with a spelling mistake, and
 * it flags two genuinely different people who share a common name and started together. A similarity
 * percentage on this page would assert a precision the data does not have, and the reporter would act on
 * it. So every comparable fact is shown in one of THREE states — they match, they DISAGREE, or the fact is
 * not recorded — and the third is the one a number could never express. There is no ranking, no
 * "likely / possible" band and no confidence anywhere in this file or the module behind it.
 *
 * ═══ ⚠️ READ-ONLY. THERE IS NO MERGE ON THIS PAGE, ON PURPOSE. ═══
 *
 * Nothing here submits anything. The only interactive element is a link to each employee's own record, so
 * a reader can go and look. Merging two person records means deciding what happens to two leave ledgers,
 * two statutory profiles, two employment histories and any payslip already issued; `person_id` is
 * referenced widely (`employee_statutory_my` and `tp1_relief` are keyed on it, leave and attendance hang
 * off employment). That is its own item with its own plan, AFTER the reporter has said which of these are
 * the same person. ORDERING: identify, show, confirm, then act.
 *
 * ═══ THE THING THE PAGE MUST NOT LET A READER MISCOUNT ═══
 *
 * One PERSON with several EMPLOYMENTS is the supported shape (CLAUDE.md §1) and is NOT a duplicate. The
 * Record letter column exists for exactly that: two rows sharing a letter are ONE person record holding
 * two jobs. Without it a genuine multi-employment person would read as two duplicates, which is the
 * mistake the whole item turns on.
 *
 * SERVER COMPONENT, no client island, so no server action and no function ever crosses a boundary
 * (test/server-client-boundary.test.ts exists because that failure is invisible to tsc, the suite and
 * `next build` alike).
 *
 * ACCESS. `requireAdmin()` here is the page gate; `core/duplicate-person.ts` refuses a non-admin caller in
 * its own right (a page guard is a UX gate, not the fence); and RLS decides which employments exist at
 * all, so a company-scoped administrator sees only the companies they administer — which is why a group
 * needs two VISIBLE person records before it is shown.
 */
export default async function DuplicatePersonRecordsPage() {
  const s = await requireAdmin();
  const t = await getTranslations('people.duplicates');
  const view = await duplicatePersonCandidates(s);

  /** Static key per field, so nothing is assembled out of a raw column name at render time. */
  const FIELD_KEY: Record<DuplicateEvidenceField, string> = {
    icNumber: 'field.icNumber',
    passportNumber: 'field.passportNumber',
    dateOfBirth: 'field.dateOfBirth',
    fullNameExact: 'field.fullNameExact',
    primaryEmail: 'field.primaryEmail',
    personalEmail: 'field.personalEmail',
    gender: 'field.gender',
    maritalStatus: 'field.maritalStatus',
    bankAccountNo: 'field.bankAccountNo',
  };
  const dash = t('notRecorded');

  return (
    <div className={pageWideCls}>
      <PageHeader
        title={t('title')}
        description={t('description')}
        back={{ href: '/admin/personnel', label: t('backToPersonnel') }}
      />

      {/* THE CAPTION IS LOAD-BEARING, not furniture. A list of names under the word "duplicates" reads as
          a verdict; these three sentences are what make it a question. They are shown above the list and
          on the empty state alike, because the caveat is true either way. */}
      <Card className="p-5">
        <p className="text-sm font-medium">{t('howToReadTitle')}</p>
        <ul className="mt-2 space-y-1.5 text-sm text-muted-foreground">
          <li>{t('howToReadSuggestion')}</li>
          <li>{t('howToReadMultiEmployment')}</li>
          <li>{t('howToReadNothingChanged')}</li>
        </ul>
      </Card>

      <Card className="p-5">
        <div className="flex flex-wrap items-end gap-8">
          <div>
            <p className="text-3xl font-semibold tabular-nums">{view.groups.length}</p>
            <p className="mt-1 text-xs text-muted-foreground">{t('statNames')}</p>
          </div>
          <div>
            <p className="text-3xl font-semibold tabular-nums">{view.extraPersonRecords}</p>
            <p className="mt-1 text-xs text-muted-foreground">{t('statExtraRecords')}</p>
          </div>
          <div>
            <p className="text-2xl font-semibold tabular-nums">{view.activeEmployments.toLocaleString()}</p>
            <p className="mt-1 text-xs text-muted-foreground">{t('statChecked')}</p>
          </div>
          <p className="max-w-md text-xs text-muted-foreground">{t('activeOnlyNote')}</p>
        </div>
        {view.sharedNamesWithDifferentHireDates > 0 && (
          // The edge of the heuristic, stated as a COUNT and never as a list: sharing a name is ordinary,
          // and printing every such name would bury the candidates under people who merely share one.
          <p className="mt-4 border-t border-border pt-3 text-xs text-muted-foreground">
            {t('sharedDifferentDates', { n: view.sharedNamesWithDifferentHireDates })}
          </p>
        )}
      </Card>

      {view.groups.length === 0 ? (
        <Card className="p-6">
          <p className="text-sm">{t('noneFound', { n: view.activeEmployments })}</p>
        </Card>
      ) : (
        view.groups.map((g) => (
          <Card key={g.key} className="overflow-hidden">
            <SectionHeader
              title={g.displayName}
              subtitle={t('groupSubtitle', {
                persons: g.personIds.length,
                employments: g.records.length,
                joined: g.hiredOn,
                companies: g.companies.join(', '),
              })}
            />
            <div className="space-y-4 px-4 pb-4 pt-3">
              <div className="flex flex-wrap gap-2">
                {/* The failure mode that matters most, and it leads. A disagreement on a recorded fact is
                    evidence these are two different people — the opposite of what the page is looking
                    for — so it is stated before anything else in the group. */}
                {g.contradictions.length > 0 && (
                  <p className="rounded-full bg-amber-500/10 px-2.5 py-1 text-[11px] font-medium text-amber-700 dark:text-amber-300">
                    {t('mayBeDifferentPeople', {
                      fields: g.contradictions.map((f) => t(FIELD_KEY[f])).join(', '),
                    })}
                  </p>
                )}
                {g.anyPayslip && (
                  <p className="rounded-full bg-rose-500/10 px-2.5 py-1 text-[11px] font-medium text-rose-700 dark:text-rose-300">
                    {t('hasBeenPaid')}
                  </p>
                )}
                {/* ⚠️ THE IC FINDING, AND IT OUTRANKS EVERYTHING ELSE ON THE CARD. Same encoded date of
                    birth with only the trailing digits apart is the shape of an IC edited to get past the
                    system's own uniqueness rule — and EPF, SOCSO and LHDN all file against that number,
                    so one of these records is filing under an identity that is not the holder's. It says
                    the consequence; it offers no correction, because this round corrects nothing. */}
                {IC_VERDICTS_INDICATING_ONE_PERSON.includes(g.icEvidence.verdict) && (
                  <p className="rounded-full bg-rose-500/10 px-2.5 py-1 text-[11px] font-medium text-rose-700 dark:text-rose-300">
                    {t('icPointsAtOnePerson')}
                  </p>
                )}
                {g.companies.length > 1 && (
                  <p className="rounded-full bg-muted px-2.5 py-1 text-[11px] font-medium text-muted-foreground">
                    {t('acrossCompanies', { n: g.companies.length })}
                  </p>
                )}
              </div>

              <div className={tableWrapCls}>
                <table className="w-full text-sm">
                  <thead className={theadCls}>
                    <tr>
                      <th className={thCls}>{t('colRecord')}</th>
                      <th className={thCls}>{t('colEmployeeId')}</th>
                      <th className={thCls}>{t('colCompany')}</th>
                      <th className={thCls}>{t('colJoined')}</th>
                      <th className={thCls}>{t('colIc')}</th>
                      <th className={thCls}>{t('colPassport')}</th>
                      <th className={thCls}>{t('colDob')}</th>
                      <th className={thCls}>{t('colEmail')}</th>
                      <th className={thCls}>{t('colBank')}</th>
                      <th className={thCls}>{t('colPayslips')}</th>
                      <th className={thCls}>{t('colLeaveEntries')}</th>
                    </tr>
                  </thead>
                  <tbody className={tbodyCls}>
                    {g.records.map((r) => (
                      <tr key={r.employmentId}>
                        {/* Two rows sharing this letter are ONE person record with two jobs — the
                            supported shape, and not a duplicate. */}
                        <td className="px-3 py-2 font-mono text-xs font-semibold">{r.personLabel}</td>
                        <td className="px-3 py-2">
                          {/* The only interactive element on the page, and it is a GET to the record
                              itself: the deliverable is getting somebody from a name to the two profiles
                              they have to compare. */}
                          <Link
                            href={`/admin/personnel/${r.employmentId}`}
                            className="text-primary hover:underline"
                          >
                            <EmployeeCode code={r.employeeCode} className="text-primary" />
                            {r.employeeCode == null && t('openRecord')}
                          </Link>
                        </td>
                        <td className="px-3 py-2">{r.company}</td>
                        <td className="px-3 py-2 tabular-nums">{r.hiredOn}</td>
                        <td className="px-3 py-2 font-mono text-xs">{r.icNumber ?? dash}</td>
                        <td className="px-3 py-2 font-mono text-xs">{r.passportNumber ?? dash}</td>
                        <td className="px-3 py-2 tabular-nums">{r.dateOfBirth ?? dash}</td>
                        <td className="px-3 py-2">{r.primaryEmail}</td>
                        <td className="px-3 py-2 font-mono text-xs">{r.bankAccountNo ?? dash}</td>
                        <td className="px-3 py-2 tabular-nums">{r.payslipCount}</td>
                        <td className="px-3 py-2 tabular-nums">{r.leaveLedgerEntries}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              <div>
                <p className="text-xs font-medium">{t('evidenceTitle')}</p>
                <ul className="mt-2 grid gap-1 sm:grid-cols-2">
                  {/* Iterated over the DECLARED field order, not over the group's own array, so every
                      group lists the same facts in the same order — including the ones nobody recorded.
                      A field that silently vanished when it was blank would read as corroboration. */}
                  {DUPLICATE_EVIDENCE_FIELDS.map((f) => {
                    const a = g.agreement.find((x) => x.field === f)!;
                    // ⚠️ THE IC DOES NOT SAY "Differs". `employee_statutory_my_ic_uq` guarantees two
                    // records cannot show the same one, so "Differs" is literally true and materially
                    // misleading — it is the answer the column is built to give. This row says what the
                    // two numbers MEAN instead: the date of birth they encode, whether the records agree
                    // with it, and how many trailing digits apart they are. Named, checkable, unscored.
                    if (f === 'icNumber') {
                      const ic = g.icEvidence;
                      return (
                        <li key={f} className="flex flex-wrap items-baseline gap-2 text-xs">
                          <span className="text-muted-foreground">{t(FIELD_KEY[f])}</span>
                          <span
                            className={
                              ic.verdict === 'different_birth_dates'
                                ? 'font-medium text-amber-700 dark:text-amber-300'
                                : ic.verdict === 'same_birth_date'
                                  ? 'font-medium text-emerald-700 dark:text-emerald-400'
                                  : 'text-muted-foreground'
                            }
                          >
                            {ic.verdict === 'not_comparable'
                              ? t('icNotComparable', { n: ic.readableCount })
                              : t(`icVerdict.${ic.verdict}`, {
                                  inIc: ic.birthDatesInIc.join(' / '),
                                  onProfile: ic.birthDatesOnProfile.join(' / '),
                                })}
                          </span>
                          {ic.differingTrailingDigits != null && (
                            // A COUNT OF DIGITS the reader can verify against the table above, not a
                            // measure of closeness: it is null whenever the numbers disagree on the
                            // birth date, so it can never stand in for a similarity figure.
                            <span className="text-[11px] text-muted-foreground">
                              {t('icTrailingDigits', { n: ic.differingTrailingDigits })}
                            </span>
                          )}
                          {ic.values.length > 0 && (
                            <span className="font-mono text-[11px] text-muted-foreground">
                              {ic.values.join(' \u00b7 ')}
                            </span>
                          )}
                        </li>
                      );
                    }
                    return (
                      <li key={f} className="flex flex-wrap items-baseline gap-2 text-xs">
                        <span className="text-muted-foreground">{t(FIELD_KEY[f])}</span>
                        <span
                          className={
                            a.state === 'differs'
                              ? 'font-medium text-amber-700 dark:text-amber-300'
                              : a.state === 'same'
                                ? 'font-medium text-emerald-700 dark:text-emerald-400'
                                : 'text-muted-foreground'
                          }
                        >
                          {a.state === 'same'
                            ? t('stateSame')
                            : a.state === 'differs'
                              ? t('stateDiffers')
                              : a.recordedBy === 0
                                ? t('stateNotRecorded')
                                : t('statePartiallyRecorded', { n: a.recordedBy, of: g.personIds.length })}
                        </span>
                        {a.values.length > 0 && (
                          <span className="font-mono text-[11px] text-muted-foreground">
                            {a.values.join(' \u00b7 ')}
                          </span>
                        )}
                        {/* WHY THIS FIELD CARRIES NO VERDICT, said INLINE and beside the field it is
                            about rather than as a footnote under the list — a reader looking at "Name
                            spelling: Differs" needs the caveat there, not three lines further down. The
                            reasons differ per field and collapsing them would make one of them wrong:
                            · IC — FACT, migration 0214: `employee_statutory_my_ic_uq` makes a non-null
                              IC unique per tenant, so two records CANNOT show the same one.
                            · Work email — a fact about the EMPLOYMENT, not the human.
                            · Name spelling — the group key IS the normalised name, so two spellings here
                              can differ only in capitalisation and spacing. That points AT one human
                              entered twice, and the first build wrongly listed it as evidence against. */}
                        {DUPLICATE_FIELD_NOT_A_CONTRADICTION[f] && (
                          <span className="text-[11px] text-muted-foreground">
                            ({t(`notCounted.${DUPLICATE_FIELD_NOT_A_CONTRADICTION[f]}`)})
                          </span>
                        )}
                      </li>
                    );
                  })}
                </ul>
                {IC_VERDICTS_INDICATING_ONE_PERSON.includes(g.icEvidence.verdict) && (
                  // The consequence, spelled out where the reader is already looking at the two IC
                  // numbers. It states what is true and stops: no repair, no proposed value, no button.
                  <p className="mt-2 rounded-md bg-rose-500/5 p-2 text-[11px] text-rose-800 dark:text-rose-300">
                    {t('icStatutoryNote')}
                  </p>
                )}
              </div>
            </div>
          </Card>
        ))
      )}
    </div>
  );
}
