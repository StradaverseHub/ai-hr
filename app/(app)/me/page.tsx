import {profileVisibilityFingerprint} from '@/lib/profile-policy-fingerprint';
import {profileHiddenTabs,isProfileVisibilityPolicyValue,profileSectionPolicyKey} from '@/lib/profile-edit-policy-value';
import {ownPhotoSubmissionAllowed} from '@/core/person-photo';
import {saveOwnPhotoAction} from './own-photo-action';
import {getSetting} from '@/core/entitlements';
import {readProfilePresentationPolicy} from '@/core/profile-edit-policy';
import Link from 'next/link';
import {redirect} from 'next/navigation';
import {getTranslations} from 'next-intl/server';
import {getSession} from '@/lib/session';
import {myOwnEmploymentSubjects,myPayslips,myTaxRelief,myTaxReliefEmploymentIds,myEmploymentIdsAll,type TaxReliefResult} from '@/core/read';
import {listLoansForEmployment} from '@/core/loans';
import {myProfileChangeRequests} from '@/core/profile';
import {isModuleEnabledOrFalse} from '@/core/entitlements';
import {myResignation} from '@/core/offboarding';
import {serviceYearsMonthsDaysAt} from '@/packs/leave/service';
import {readOwnProfileWorkspace} from '@/core/profile-edit';
import {readOwnProfileFacts} from '@/core/profile-view';
import {essFactVisible} from '@/lib/personnel-ess-visibility';
import {personnelField} from '@/lib/personnel-field-registry';
import {personnelFieldChoices} from '@/lib/personnel-import-contract';
import {profileProposalLines} from '@/lib/profile-proposal-display';
import {ProfileEditor} from './profile-editor';
import {Avatar,Badge,Button,Card,ErrorBanner,Field,PageHeader,SectionHeader,inputCls} from '@/components/ui';
import {todayInKualaLumpur} from '@/lib/hr-date';
import {formatDmy} from '@/lib/date-display';
import {myProfileRecord} from './record';
import {MONO_ME_SECTION_HEAD,ReadCard,ReadField} from './read-field';
import {MeReviewCard} from './review-card';
import {ME_TABS,type MeTabKey} from './visible-fields';
import {mySubmitResignation,myWithdrawResignation} from './actions';
const ME_TAB_SET=new Set<string>(ME_TABS);
const LEGACY_TAB:Record<string,MeTabKey>={overview:'profile',pay:'payroll'};
// Currency remains a separately recorded fact; never assume a jurisdiction or convert money here.
const rm=(value:unknown)=>Number(value??0).toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2});
const MONO_FLUSH='monolith:[&>*]:px-0';
const MONO_TABLE='monolith:font-mono monolith:text-[13px]';
const MONO_THEAD='monolith:bg-transparent monolith:font-mono monolith:text-[11px]';
const MONO_RUN_WORD='monolith:rounded-none monolith:bg-transparent monolith:px-0';
const MONO_TXT_LINK='monolith:rounded-none monolith:border-x-0 monolith:border-t-0';
/** My Profile shares Personnel field identities and safe canonical owner projections. Clocking stays on My Attendance. */
export default async function MePage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; month?: string; cycle?: string; asOf?: string; tab?: string; employmentId?:string }>;
}) {
  const t = await getTranslations('me');

  const tp = await getTranslations('people.detail');
  const tRun = await getTranslations('payroll.list.runType'); // Wave 2C — shared run-type labels
  const s = await getSession();
  const { error, month: spMonth, cycle: spCycle, asOf: spAsOf, tab: spTab, employmentId:requestedEmploymentId } = await searchParams;

  if (spTab === 'performance') redirect('/me/performance');

  const te=await getTranslations('essProfile'),allLabels=await getTranslations();
  const presentation=await readProfilePresentationPolicy(s);
  const visible=presentation.visible;
  const visibilityPolicy=getSetting(presentation.ctx,'ess.profile_change_fields');
  const hiddenTabs=new Set<string>(profileHiddenTabs(visibilityPolicy));
  const tabVisible=(tab:string)=>!hiddenTabs.has(tab);
  const sectionVisible=(tab:string,section:string)=>tabVisible(tab)&&(!isProfileVisibilityPolicyValue(visibilityPolicy)||visibilityPolicy.version===3||visibilityPolicy.groups[profileSectionPolicyKey(tab,section)]!=='hide');
  const canSee=(owner:string,field:string)=>essFactVisible(visible,owner,field);
  const own=await myOwnEmploymentSubjects(s,{profileEdit:true});
  const selected=requestedEmploymentId?own.find(row=>row.employmentId===requestedEmploymentId):own.length===1?own[0]:null;
  if(!selected&&own.length>0)return <div className="mx-auto max-w-2xl space-y-4"><PageHeader title={t('title')} description={te('chooseEmployment')}/>{requestedEmploymentId&&<ErrorBanner message={te('error.permission')}/>}<Card className="p-5"><ul className="space-y-3">{own.map(row=><li key={row.employmentId}><Link href={`/me?employmentId=${row.employmentId}`} className="text-primary underline">{canSee('employment','employeeCode')?row.employeeCode:''} · {canSee('assignment','companyName')?row.company:''}</Link></li>)}</ul></Card></div>;
  const record = selected?await myProfileRecord(s,selected.employmentId):null;

  if (!record) {
    return (
      <div className="mx-auto max-w-2xl">
        <Card className="p-8 text-center">
          <h1 className="text-lg font-semibold">{t('title')}</h1>
          <p className="mt-2 text-sm text-muted-foreground">{t('notLinked')}</p>
        </Card>
      </div>
    );
  }

  const { employmentId } = record;
  const employments = own;
  const [workspace,facts]=await Promise.all([readOwnProfileWorkspace(s,{employmentId},presentation),readOwnProfileFacts(s,employmentId,presentation)]);

  const payrollOn = isModuleEnabledOrFalse(s, 'payroll')&&tabVisible('Payroll');

  const taxReliefEmploymentIds = payrollOn ? await myTaxReliefEmploymentIds(s) : [];
  const noTaxRelief: TaxReliefResult = { year: Number(todayInKualaLumpur().slice(0, 4)), rows: [], ytd: 0 };

  const [payslips, taxRelief, profileRequests, resignation, myLoans] = await Promise.all([
    payrollOn ? myPayslips(s, employments.map((e) => e.employmentId)) : [],
    payrollOn ? myTaxRelief(s, taxReliefEmploymentIds) : noTaxRelief,
    myProfileChangeRequests(s,50,presentation),
    tabVisible('Documents')?myResignation(s, employmentId):null,

    payrollOn ? listLoansForEmployment(s, employmentId) : [],
  ]);

  const taxReliefByCompany = taxRelief.rows.reduce<Record<string, typeof taxRelief.rows>>((acc, r) => {
    (acc[r.company] ??= []).push(r);
    return acc;
  }, {});

  const today = todayInKualaLumpur();

  const eaEmployments = tabVisible('Documents')?await myEmploymentIdsAll(s):[];
  const eaPayslips = tabVisible('Documents')?await myPayslips(s, eaEmployments.map((e) => e.employmentId)):[];
  const ownHistoricalIds=new Set(eaEmployments.map(row=>row.employmentId));
  const eaRowMap = new Map<string, { employmentId: string; company: string; year: string }>();
  for (const ps of eaPayslips) {
    const year = ps.payPeriod.slice(0, 4); // 'YYYY-MM' → 'YYYY'
    const eaEmploymentId=ps.employmentId;
    if(!ownHistoricalIds.has(eaEmploymentId))continue;
    const key=`${eaEmploymentId}::${ps.company}::${year}`;
    if (!eaRowMap.has(key)) eaRowMap.set(key, { employmentId: eaEmploymentId, company: ps.company, year });
  }
  const eaRows = [...eaRowMap.values()].sort(
    (a, b) => a.company.localeCompare(b.company) || b.year.localeCompare(a.year),
  );

  const finalizedPayslips = payslips.filter((p) => p.status === 'closed' && p.released);
  const payslipMonths = [...new Set(finalizedPayslips.map((p) => p.payPeriod))].sort((a, b) =>
    a < b ? 1 : a > b ? -1 : 0,
  );
  const selectedMonth = spMonth && payslipMonths.includes(spMonth) ? spMonth : payslipMonths[0] ?? '';
  const monthRows = finalizedPayslips.filter((p) => p.payPeriod === selectedMonth);
  const cycleKeyOf = (p: { runType: string; runSeq: number }) => `${p.runType}#${p.runSeq}`;
  const cycleCountByType = monthRows.reduce<Record<string, number>>((acc, p) => {
    acc[p.runType] = (acc[p.runType] ?? 0) + 1;
    return acc;
  }, {});
  const seenCycleKeys = new Set<string>();
  const payslipCycles: { key: string; runType: string; runSeq: number }[] = [];
  for (const p of monthRows) {
    const key = cycleKeyOf(p);
    if (seenCycleKeys.has(key)) continue;
    seenCycleKeys.add(key);
    payslipCycles.push({ key, runType: p.runType, runSeq: p.runSeq });
  }
  const cycleLabelOf = (c: { runType: string; runSeq: number }) =>
    cycleCountByType[c.runType] > 1
      ? t('cycleLabel', { runType: tRun(c.runType), seq: c.runSeq })
      : t('cycleLabelSingle', { runType: tRun(c.runType) });
  const selectedCycle =
    spCycle && payslipCycles.some((c) => c.key === spCycle) ? spCycle : payslipCycles[0]?.key ?? '';
  const displayedPayslips = monthRows.filter((p) => cycleKeyOf(p) === selectedCycle);

  const activeTab: MeTabKey = spTab && ME_TAB_SET.has(spTab)
    ? (spTab as MeTabKey)
    : (spTab && LEGACY_TAB[spTab]) || 'profile';

  const notSet = tp('optionNotSet');
  const paymentMethodLabel = (m: string | null) =>
    m === 'bank_transfer'
      ? tp('paymentMethod_bank_transfer')
      : m === 'cheque'
        ? tp('paymentMethod_cheque')
        : m === 'cash'
          ? tp('paymentMethod_cash')
          : null;
  const fmtServiceYmd = (from: string | null | undefined): string | null => {
    if (!from) return null;
    const sv = serviceYearsMonthsDaysAt(from, today);
    const parts: string[] = [];
    if (sv.years > 0) parts.push(tp('employmentInfo.yearsUnit', { count: sv.years }));
    if (sv.years > 0 || sv.months > 0) parts.push(tp('employmentInfo.monthsUnit', { count: sv.months }));
    parts.push(tp('employmentInfo.daysUnit', { count: sv.days }));
    return parts.join(' ');
  };

  const {employment:emp,compensation:comp}=record;

  const compensationChoice=(fieldName:string,value:string|null|undefined)=>{if(value==null)return null;const field=personnelField(`payroll.basic_salary_and_salary_history.${fieldName}`);const choice=field?personnelFieldChoices(field).find(option=>option.value===value):null;return choice?allLabels(choice.labelKey):value;};

  const payrollPanel = (
    <>
      {/* The CURRENT salary only. The revision history is withheld — each past row carries HR's remark on
          why the increment was given, which is a conversation and not a field. See
          docs/me-profile-field-visibility.md. */}
      {sectionVisible('Payroll','Basic Salary and salary history')&&<ReadCard id="section-compensation" title={tp('compensation')}>
        {/* WHOSE PAY, AND FOR WHICH EMPLOYMENT. This card is the compensation row of the employment /me
            resolved from the session; an employee holding two of them (ADR-0009) would otherwise read one
            unlabelled figure and have no way to tell which contract it belongs to. The other positions and
            their pay are on the Employment tab's "My positions" card. */}
        {canSee('assignment','companyName')&&<ReadField label={tp('employmentInfo.company')} value={canSee('assignment','companyName')?emp.company:null} notSet={notSet} />}
        {canSee('compensation','basicSalary')&&<ReadField label={tp('basicSalaryMyr')} value={canSee('compensation','basicSalary')&&comp?Number(comp.basicSalary).toFixed(2):null} notSet={notSet} />}
        {canSee('compensation','currency')&&<ReadField label={tp('salaryCurrency')} value={canSee('compensation','currency')?comp?.currency??null:null} notSet={notSet} />}
        {canSee('compensation','validFrom')&&<ReadField label={tp('effectiveDate')} value={canSee('compensation','validFrom')&&comp?.validFrom?formatDmy(comp.validFrom):null} notSet={notSet} />}
        {canSee('compensation','payMode')&&<ReadField label={tp('payMode')} value={canSee('compensation','payMode')?compensationChoice('paymode',comp?.payMode):null} notSet={notSet} />}
        {canSee('compensation','paymentTerm')&&<ReadField label={tp('paymentTerm')} value={canSee('compensation','paymentTerm')?compensationChoice('paymentterm',comp?.paymentTerm):null} notSet={notSet} />}
        {/* Daily / hourly staff are paid from the rate, not the basic — it was already projected in
            app/(app)/me/record.ts and simply never put on screen. Blank for a monthly contract, like any other
            field that is not recorded. */}
        {canSee('compensation','rateAmount')&&<ReadField label={tp('rateAmount')} value={canSee('compensation','rateAmount')?comp?.rateAmount??null:null} notSet={notSet} />}
        {canSee('compensation','status')&&<ReadField label={tp('status')} value={canSee('compensation','status')&&comp?tp('salaryStatusActive'):null} notSet={notSet} />}
      </ReadCard>}

      {/* r298 — this card, TP1 and My loans are the Payroll pack's; absent (and unread) without Payroll. */}
      {payrollOn && (
      <Card className={`overflow-hidden ${MONO_FLUSH}`} data-tour="me-payslips">
        <SectionHeader title={t('myPayslips')} count={finalizedPayslips.length} className={MONO_ME_SECTION_HEAD} />
        {payslipMonths.length === 0 && <p className="p-4 text-sm text-muted-foreground">{t('noPayslipsYet')}</p>}
        {payslipMonths.length > 0 && (
          // Native GET round-trip: `tab=payroll` so the full-document reload lands back on this tab.
          <form method="get" className="grid grid-cols-1 items-end gap-3 border-b border-border p-4 sm:grid-cols-3">
            <input type="hidden" name="tab" value="payroll" />
            <input type="hidden" name="employmentId" value={employmentId} />
            <Field label={t('selectMonth')}>
              <select name="month" defaultValue={selectedMonth} className={inputCls}>
                {payslipMonths.map((m) => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))}
              </select>
            </Field>
            <Field label={t('selectCycle')}>
              <select name="cycle" defaultValue={selectedCycle} className={inputCls}>
                {payslipCycles.map((cy) => (
                  <option key={cy.key} value={cy.key}>
                    {cycleLabelOf(cy)}
                  </option>
                ))}
              </select>
            </Field>
            <Button type="submit" size="sm">
              {t('selectCycle')}
            </Button>
          </form>
        )}
        <div className="overflow-x-auto">
          <table className={`w-full text-sm ${MONO_TABLE}`}>
            <thead className={`bg-muted/50 text-left text-xs uppercase tracking-wide text-muted-foreground ${MONO_THEAD}`}>
              <tr>
                <th className="px-4 py-2 font-medium">{t('colPeriod')}</th>
                <th className="px-4 py-2 font-medium">{t('colCompany')}</th>
                <th className="px-4 py-2 text-right font-medium">{t('colGross')}</th>
                <th className="px-4 py-2 text-right font-medium">{t('colDeductions')}</th>
                <th className="px-4 py-2 text-right font-medium">{t('colNet')}</th>
                <th className="px-4 py-2 font-medium">{t('colStatus')}</th>
                <th className="px-4 py-2" />
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {displayedPayslips.map((ps) => (
                <tr key={ps.id}>
                  <td className="px-4 py-2.5 font-medium">
                    <Link href={`/me/payslip/${ps.id}`} className="text-primary hover:underline">
                      {ps.payPeriod}
                    </Link>
                    {ps.runType !== 'regular' && (
                      <span className={`ml-2 inline-flex rounded-full bg-amber-50 px-2 py-0.5 text-xs font-medium text-amber-700 dark:bg-amber-500/10 dark:text-amber-400 ${MONO_RUN_WORD}`}>
                        {tRun(ps.runType)}
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-2.5 text-muted-foreground">{ps.company}</td>
                  <td className="px-4 py-2.5 text-right tabular-nums">{rm(ps.gross)}</td>
                  <td className="px-4 py-2.5 text-right tabular-nums text-muted-foreground">{rm(ps.deductions)}</td>
                  <td className="px-4 py-2.5 text-right font-medium tabular-nums">{rm(ps.net)}</td>
                  <td className="px-4 py-2.5 text-muted-foreground">{t(`payrollStatus.${ps.status}`)}</td>
                  <td className="px-4 py-2.5 text-right">
                    <a
                      href={`/me/payslip/${ps.id}/pdf`}
                      download
                      className={`inline-flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-xs font-medium transition-colors hover:bg-muted ${MONO_TXT_LINK}`}
                    >
                      {t('payslip.downloadPdf')}
                    </a>
                  </td>
                </tr>
              ))}
              {displayedPayslips.length === 0 && (
                <tr>
                  <td colSpan={7} className="px-4 py-8 text-center text-muted-foreground">
                    {t('noPayslips')}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </Card>
      )}

      {/* My Payroll — Self Personal Tax Relief (LHDN TP1). Year-scoped, grouped per company. */}
      {payrollOn && (
      <Card className={`overflow-hidden ${MONO_FLUSH}`}>
        <SectionHeader title={t('taxReliefTp1')} count={taxRelief.rows.length} className={MONO_ME_SECTION_HEAD} />
        <p className="px-4 pb-2 pt-1 text-xs text-muted-foreground">
          {t('taxReliefDescription', { year: String(taxRelief.year) })}
        </p>
        <p className="px-4 pb-3">
          <Link href="/me/tax-relief" className="text-sm font-medium text-primary underline-offset-2 hover:underline">
            {t('manageTp1')} →
          </Link>
        </p>
        {taxRelief.rows.length === 0 ? (
          <p className="px-4 pb-4 text-sm text-muted-foreground">{t('noTaxRelief')}</p>
        ) : (
          <div className="overflow-x-auto">
            <table className={`w-full text-sm ${MONO_TABLE}`}>
              <thead className={`bg-muted/50 text-left text-xs uppercase tracking-wide text-muted-foreground ${MONO_THEAD}`}>
                <tr>
                  <th className="px-4 py-2 font-medium">{t('colCompany')}</th>
                  <th className="px-4 py-2 font-medium">{t('colPeriod')}</th>
                  <th className="px-4 py-2 text-right font-medium">{t('colTp1')}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {Object.entries(taxReliefByCompany).map(([companyName, rows]) => {
                  const subtotal = rows.reduce((sum, r) => sum + r.tp1, 0);
                  return rows
                    .map((r, i) => (
                      <tr key={`${companyName}-${r.payPeriod}-${r.runType}`}>
                        {i === 0 && (
                          <td rowSpan={rows.length} className="px-4 py-2.5 align-top font-medium text-muted-foreground">
                            {companyName}
                          </td>
                        )}
                        <td className="px-4 py-2.5 font-medium">
                          {r.payPeriod}
                          {r.runType !== 'regular' && (
                            <span className={`ml-2 inline-flex rounded-full bg-amber-50 px-2 py-0.5 text-xs font-medium text-amber-700 dark:bg-amber-500/10 dark:text-amber-400 ${MONO_RUN_WORD}`}>
                              {tRun(r.runType)}
                            </span>
                          )}
                        </td>
                        <td className="px-4 py-2.5 text-right tabular-nums">{rm(r.tp1)}</td>
                      </tr>
                    ))
                    .concat(
                      <tr key={`${companyName}-subtotal`} className="bg-muted/30">
                        <td className="px-4 py-2 text-right text-xs font-medium text-muted-foreground" colSpan={2}>
                          {companyName}
                        </td>
                        <td className="px-4 py-2 text-right font-medium tabular-nums">{rm(subtotal)}</td>
                      </tr>,
                    );
                })}
              </tbody>
              <tfoot>
                <tr className="border-t border-border">
                  <td className="px-4 py-2.5 text-right font-medium" colSpan={2}>
                    {t('yearTaxRelief', { year: String(taxRelief.year) })}
                  </td>
                  <td className="px-4 py-2.5 text-right font-semibold tabular-nums">{rm(taxRelief.ytd)}</td>
                </tr>
              </tfoot>
            </table>
          </div>
        )}
      </Card>
      )}

      {/* 1.2.8 My loans (ADR-0060) — read-only: outstanding balance + per-instalment schedule. */}
      {payrollOn && myLoans.length > 0 && (
        <Card className={`overflow-hidden ${MONO_FLUSH}`}>
          <SectionHeader title={t('myLoans')} count={myLoans.length} className={MONO_ME_SECTION_HEAD} />
          <table className={`w-full text-sm ${MONO_TABLE}`}>
            <thead className={`bg-muted/50 text-left text-xs uppercase tracking-wide text-muted-foreground ${MONO_THEAD}`}>
              <tr>
                <th className="px-4 py-2 font-medium">{t('loanType')}</th>
                <th className="px-4 py-2 text-right font-medium">{t('loanInstalment')}</th>
                <th className="px-4 py-2 text-right font-medium">{t('loanOutstanding')}</th>
                <th className="px-4 py-2 text-right font-medium">{t('loanProgress')}</th>
                <th className="px-4 py-2 font-medium">{t('loanStatus')}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {myLoans.map((l) => (
                <tr key={l.id}>
                  <td className="px-4 py-2.5">{t(`loanTypeName.${l.loanType}`)}</td>
                  <td className="px-4 py-2.5 text-right tabular-nums">{rm(l.monthlyInstalment)}</td>
                  <td className="px-4 py-2.5 text-right tabular-nums">{rm(l.outstandingBalance)}</td>
                  <td className="px-4 py-2.5 text-right tabular-nums">
                    {l.instalmentsPaid}/{l.durationMonths}
                  </td>
                  <td className="px-4 py-2.5">{t(`loanStatusName.${l.status}`)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}
    </>
  );

  const documentsPanel = (
    <>
      {/* r298 — without Payroll the card is drawn only when a statement exists (a company that ran payroll
          and then dropped it), and only the PDF link is offered: /payroll/reports/ea sits behind the Payroll
          layout. A company that never ran payroll sees no EA card at all. */}
      {(payrollOn || eaRows.length > 0) && (
      <Card className={`p-5 ${MONO_FLUSH} monolith:p-0`}>
        <SectionHeader title={t('taxStatementEa')} className={MONO_ME_SECTION_HEAD} />
        <p className="px-1 pt-2 text-xs text-muted-foreground">{t('taxStatementDescription')}</p>
        {eaRows.length === 0 ? (
          <p className="mt-3 rounded-lg border border-dashed border-border p-3 text-sm text-muted-foreground">
            {t('noPayslips')}
          </p>
        ) : (
          <ul className="mt-3 space-y-2">
            {eaRows.map((r) => (
              <li
                key={`${r.employmentId}-${r.year}`}
                className="flex items-center justify-between gap-3 rounded-lg border border-border p-3 text-sm"
              >
                <span>
                  {r.company} · <span className="text-muted-foreground">{t('yearOfAssessment', { year: r.year })}</span>
                </span>
                <span className="flex items-center gap-3">
                  {payrollOn && (
                    <Link href={`/payroll/reports/ea/${r.employmentId}?year=${r.year}`} className="text-primary hover:underline">
                      {t('viewDownload')}
                    </Link>
                  )}
                  <Link href={`/me/ea/${r.employmentId}/pdf?year=${r.year}`} className="text-primary hover:underline">
                    {t('eaDownloadPdf')}
                  </Link>
                </span>
              </li>
            ))}
          </ul>
        )}
      </Card>
      )}

      {/* Employment review outcome (0110) — info-only; surfaces the employee's own completed review. */}
      <MeReviewCard s={s} employmentId={employmentId} />

      {/* Resignation (ADR-0042, #29) — employee-initiated, HR-approved. */}
      <Card className={`p-5 ${MONO_FLUSH} monolith:p-0`}>
        <SectionHeader title={t('resignationTitle')} className={MONO_ME_SECTION_HEAD} />
        <p className="px-1 pt-2 text-xs text-muted-foreground">{t('resignationDescription')}</p>
        {resignation?.status === 'pending' ? (
          <div className="mt-3 space-y-3 rounded-lg border border-border bg-muted/30 p-4">
            <div className="text-sm">
              <div className="font-medium">{t('resignationPendingTitle')}</div>
              <div className="mt-1 text-muted-foreground">
                {t('lastWorkingDayLabel')}: <span className="tabular-nums">{resignation.lastWorkingDay}</span>
              </div>
              {resignation.reason && <div className="mt-0.5 text-muted-foreground">{resignation.reason}</div>}
            </div>
            <form action={myWithdrawResignation}>
              <input type="hidden" name="requestId" value={resignation.id} />
              <Button type="submit" size="sm" variant="outline">
                {t('withdrawResignation')}
              </Button>
            </form>
          </div>
        ) : resignation?.status === 'accepted' ? (
          <p className="mt-3 rounded-lg border border-border bg-muted/30 p-4 text-sm text-muted-foreground">
            {t('resignationAcceptedNote', { date: resignation.lastWorkingDay })}
          </p>
        ) : (
          <form action={mySubmitResignation} className="mt-3 space-y-3">
            {resignation?.status === 'rejected' && <p className="text-xs text-muted-foreground">{t('resignationWasRejected')}</p>}
            {resignation?.status === 'withdrawn' && <p className="text-xs text-muted-foreground">{t('resignationWasWithdrawn')}</p>}
            <Field label={t('lastWorkingDayLabel')}>
              <input type="date" name="lastWorkingDay" required className={inputCls} />
            </Field>
            <Field label={t('resignationReasonLabel')}>
              <textarea name="reason" rows={3} className={inputCls} placeholder={t('resignationReasonPlaceholder')} />
            </Field>
            {/* #42cff598: supporting documents. `accept` is a client hint only — validateLeaveDocument is
                the real server-side gate. */}
            <Field label={t('resignationDocumentLabel')}>
              <input
                type="file"
                name="document"
                multiple
                accept="image/jpeg,image/png,application/pdf"
                className="block w-full text-sm text-muted-foreground file:mr-3 file:rounded-md file:border-0 file:bg-muted file:px-3 file:py-1.5 file:text-sm file:font-medium file:text-foreground hover:file:bg-muted/70"
              />
              <p className="mt-1 text-xs text-muted-foreground">{t('resignationDocumentHint')}</p>
            </Field>
            <Button type="submit" size="sm" variant="outline">
              {t('submitResignation')}
            </Button>
          </form>
        )}
      </Card>
    </>
  );

  const history=profileRequests.map(request=>({id:request.id,status:request.status,createdAt:request.createdAt.toISOString(),decisionReason:request.decisionReason,lines:profileProposalLines(request.proposed,(key,fallback)=>allLabels.has(key)?allLabels(key):fallback,{mask:true})}));
  const attendancePanel=<Card className="p-4" data-tour="me-attendance"><div className="flex flex-wrap gap-4"><Link href="/attendance" className="text-primary underline">{t('viewAttendanceHistory')}</Link><Link href="/attendance/requests" className="text-primary underline">{t('fileAttendanceRequest')}</Link></div></Card>;
  const leavePanel=<Card className="p-4"><Link href="/leave" className="text-primary underline">{allLabels('nav.myAbsence')}</Link></Card>;
  // 28 Oct 2026 (owner): the Assistant row is hidden without access, so a person's own Assistant data controls
  // (which survive access removal) are reached from here.
  const assistantData=await getTranslations('assistant.home');
  return <div className="mx-auto max-w-[90rem] space-y-5">
    <PageHeader title={t('title')} description={facts.header.company}/><ErrorBanner message={error}/>
    <Card className="p-4 sm:p-6"><div className="flex flex-wrap items-start gap-4"><Avatar name={facts.header.name} src={facts.header.photo?`/personnel/photo/${workspace.personId}`:null} className="size-20"/><div className="min-w-0 flex-1"><p className="text-xs text-muted-foreground">{facts.header.employeeCode}</p><h2 className="mt-1 text-xl font-semibold">{facts.header.name}</h2><p className="mt-1 text-sm text-muted-foreground">{facts.header.company}</p><p className="mt-1 text-sm text-muted-foreground">{facts.header.department??'—'} · {facts.header.position??'—'}</p><div className="mt-3 flex flex-wrap items-center gap-3">{facts.header.status&&<Badge>{allLabels(`people.employeeStatus.${facts.header.status}`)}</Badge>}<span className="text-sm">{tp('directSuperiorTitle')}: {facts.header.superior??'—'}</span><span className="text-sm">{tp('employmentInfo.groupService')}: {canSee('employment','hiredOn')?fmtServiceYmd(emp.hiredOn):null}</span></div></div>{own.length>1&&<form method="get"><Field label={te('chooseEmployment')}><select name="employmentId" defaultValue={employmentId} className={inputCls}>{own.map(row=><option key={row.employmentId} value={row.employmentId}>{canSee('employment','employeeCode')?row.employeeCode:''} · {canSee('assignment','companyName')?row.company:''}</option>)}</select></Field><Button type="submit" variant="outline" size="sm" className="mt-2">{te('chooseEmployment')}</Button></form>}</div></Card>
    {ownPhotoSubmissionAllowed(presentation)&&<Card className="p-4"><form action={saveOwnPhotoAction} className="flex flex-wrap items-end gap-3"><input type="hidden" name="employmentId" value={employmentId}/><Field label={te('ownPhoto')}><input type="file" name="photo" accept="image/png,image/jpeg" required className={inputCls}/></Field><Button type="submit" variant="outline">{te('submitPhoto')}</Button><p className="text-xs text-muted-foreground">{te('photoFormats')}</p></form></Card>}
    {visible.has('profile.personal_details.photo')&&profileRequests.filter(request=>request.status==='pending'&&request.proposed&&typeof request.proposed==='object'&&'kind' in request.proposed&&request.proposed.kind==='photo').map(request=><Card key={request.id} className="space-y-3 p-4"><h3 className="font-medium">{te('pendingPhoto')}</h3><p className="text-sm text-muted-foreground">{te('photoApprovalHelp')}</p><img src={`/me/photo-proposal/${request.id}`} alt={te('proposedPhoto')} className="size-24 rounded-md object-cover"/></Card>)}
    {!workspace.statutoryAvailable&&<Card className="p-4 text-sm text-muted-foreground">{te('countryUnavailable')}</Card>}
    <ProfileEditor key={employmentId+':'+profileVisibilityFingerprint(visibilityPolicy)} workspace={workspace} facts={facts} defaultTab={activeTab} history={tabVisible('Others')?history:[]} hiddenTabs={[...hiddenTabs]} extraPanels={{payroll:tabVisible('Payroll')?payrollPanel:null,documents:sectionVisible('Documents','Employee documents')?documentsPanel:null,attendance:tabVisible('Attendance')&&facts.modules.attendance?attendancePanel:null,leave:tabVisible('Leave')&&facts.modules.leave?leavePanel:null,others:tabVisible('Others')?<Card className="p-4"><Link href="/me/performance" className="text-primary underline">{t('myPerformanceLink')}</Link></Card>:null}}/>
    <Card className="flex flex-wrap items-center justify-between gap-3 p-4"><div className="min-w-0"><p className="text-sm font-medium">{assistantData('dataTitle')}</p><p className="mt-1 text-xs text-muted-foreground">{assistantData('dataHelp')}</p></div><Link href="/assistant#assistant-privacy" className="inline-flex min-h-11 items-center text-sm font-medium text-primary hover:underline">{assistantData('dataLink')}</Link></Card>
  </div>;
}
