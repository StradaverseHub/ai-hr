import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { scopedAdmin } from '@/lib/scope';
import { listEmployees, listEmployeesPage, listCompanies, listDepartments, employmentSubject } from '@/core/read';
import { getTp1ForPerson, listTp1YearsForPerson } from '@/core/tax-relief';
import { Button, Card, ErrorBanner, Field, PageHeader, SectionHeader, inputCls } from '@/components/ui';
import { Tp1DeclarationForm } from '@/components/tp1-declaration-form';
import { Pager } from '@/components/pager';
import { pageState, parsePageQuery } from '@/lib/pagination';
import { adminSaveTp1Draft, adminSubmitTp1 } from '../deductions-actions';

/**
 * HR Payroll — TP1 Relief (Standardize-TP1, item 0cde61f3).
 *
 * Rebuilt so HR maintains the employee's ACTUAL LHDN TP1 declaration — the SAME single tp1_relief master
 * row the employee edits on My Profile › Pay › Personal Tax Relief — rather than a separate per-batch relief
 * figure. There is exactly one declaration per employee per assessment year: what HR sees is what the
 * employee sees, and either side's save is immediately the current truth for both (no duplicate store).
 *
 * The screen is: (1) an employee search (by ID / name / company / department, scoped to the admin's
 * companies), (2) a year selector, and (3) the SHARED `<Tp1DeclarationForm>` — identical layout, fields,
 * help text, and validation to the ESS screen. HR's save goes in as a submitted correction (or a draft),
 * writing on-behalf via adminSubmitTp1 / adminSaveTp1Draft, with HR recorded as the audit actor.
 *
 * The per-run TP1 override (a single month's figure for one payroll) still lives on the Individual
 * Transaction screen (payroll_input.tp1_deduction) and is fed from this declaration by prefill — that path
 * is intentionally NOT moved here.
 */
export default async function Tp1DeclarationPage({
  searchParams,
}: {
  searchParams: Promise<{
    q?: string;
    companyId?: string;
    departmentId?: string;
    employmentId?: string;
    year?: string;
    error?: string;
    toast?: string;
    page?: string;
    size?: string;
  }>;
}) {
  const { s, scopeIds } = await scopedAdmin();
  const t = await getTranslations('payroll.transactions');
  const sp = await searchParams;
  const { q, companyId, departmentId, employmentId, year: spYear, error } = sp;

  // 3e3d3fb2 — NARROW THE SELECTION TO THE ADMIN'S OWN COMPANY SCOPE, the way every sibling transaction
  // screen already does (fixed/page.tsx and zakat/page.tsx both run employees.some(...) before trusting
  // the id). TP1 was the only one passing ?employmentId= straight through.
  //
  // WHAT THIS IS AND IS NOT — measured, because the difference matters to whoever reads this next.
  // The database already fails closed on COMPANY SCOPE: employment's RLS is
  //     tenant_id = current_tenant AND (can_see_employment(id) OR can_admin_payroll_for(company_id) OR …)
  // and both helpers go through app.is_admin_for(). test/tp1-scope-guard.test.ts proves employmentSubject
  // returns null for an out-of-scope employment even without this line. So this is NOT closing a hole
  // through which anyone could read anyone.
  //
  // What it DOES close is the residue: can_see_employment also returns true through the manager and
  // head-of-department branches, which cross company boundaries by design. An hr_admin who happens to
  // line-manage somebody outside their admin companies would pass RLS for that person — fine for a
  // profile screen, wrong for a tax declaration. Scoping to the same list the picker offers makes the
  // reachable set and the visible set the same thing, which is the property the sibling screens have.
  const scopedEmployees = await listEmployees(s, scopeIds);
  const selectedEmploymentId =
    employmentId && scopedEmployees.some((e) => e.employmentId === employmentId) ? employmentId : null;
  const subject = selectedEmploymentId ? await employmentSubject(s, selectedEmploymentId) : null;

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <PageHeader
        back={{ href: '/payroll/transactions', label: t('title') }}
        title={t('tp1.title')}
        description={t('tp1.subtitle')}
      />

      <ErrorBanner message={error} />

      {subject ? (
        <EmployeeDeclaration s={s} subject={subject} spYear={spYear} />
      ) : (
        <EmployeeSearch
          s={s}
          scopeIds={scopeIds}
          q={q}
          companyId={companyId}
          departmentId={departmentId}
          page={sp.page}
          size={sp.size}
        />
      )}
    </div>
  );
}

/** The employee picker: text search (ID / name / email) + company + department filters, scoped. */
async function EmployeeSearch({
  s,
  scopeIds,
  q,
  companyId,
  departmentId,
  page,
  size,
}: {
  s: Awaited<ReturnType<typeof scopedAdmin>>['s'];
  scopeIds: string[];
  q?: string;
  companyId?: string;
  departmentId?: string;
  page?: string;
  size?: string;
}) {
  const t = await getTranslations('payroll.transactions');
  const [companies, departments] = await Promise.all([
    listCompanies(s),
    listDepartments(s, { companyIds: scopeIds }),
  ]);
  // Only run the search once the admin has entered/selected something — a bare screen shows the prompt.
  const hasQuery = !!(q?.trim() || companyId || departmentId);
  // fc776376 — the results are a genuine list; they used to stop dead at a hard-coded 50 with nothing on
  // screen to say so. Now they page, with a real total.
  const pq = parsePageQuery({ page, size });
  const { rows, total } = hasQuery
    ? await listEmployeesPage(s, {
        companyIds: scopeIds,
        q: q?.trim() || undefined,
        companyId: companyId || undefined,
        departmentId: departmentId || undefined,
        limit: pq.limit,
        offset: pq.offset,
      })
    : { rows: [], total: 0 };

  return (
    <>
      <Card className="p-4">
        <form method="GET" className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field label={t('tp1.searchLabel')}>
            <input name="q" defaultValue={q ?? ''} placeholder={t('tp1.searchPlaceholder')} className={inputCls} />
          </Field>
          <Field label={t('tp1.companyLabel')}>
            <select name="companyId" defaultValue={companyId ?? ''} className={inputCls}>
              <option value="">{t('tp1.allCompanies')}</option>
              {companies.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label={t('tp1.departmentLabel')}>
            <select name="departmentId" defaultValue={departmentId ?? ''} className={inputCls}>
              <option value="">{t('tp1.allDepartments')}</option>
              {departments.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name}
                </option>
              ))}
            </select>
          </Field>
          <div className="flex items-end">
            <Button type="submit" variant="secondary">
              {t('tp1.search')}
            </Button>
          </div>
        </form>
      </Card>

      {hasQuery && (
        <Card className="overflow-hidden">
          <SectionHeader title={t('tp1.results')} count={total} />
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-muted/50 text-left text-xs uppercase tracking-wide text-muted-foreground">
                <tr>
                  <th className="px-4 py-2 font-medium">{t('tp1.employee')}</th>
                  <th className="px-4 py-2 font-medium">{t('tp1.employeeCode')}</th>
                  <th className="px-4 py-2 font-medium">{t('tp1.companyLabel')}</th>
                  <th className="px-4 py-2 font-medium">{t('tp1.departmentLabel')}</th>
                  <th className="px-4 py-2" />
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {rows.map((r) => (
                  <tr key={r.employmentId}>
                    <td className="px-4 py-2.5 font-medium">{r.name}</td>
                    <td className="px-4 py-2.5 tabular-nums">{r.employeeCode ?? '—'}</td>
                    <td className="px-4 py-2.5">{r.company}</td>
                    <td className="px-4 py-2.5">{r.department ?? '—'}</td>
                    <td className="px-4 py-2.5 text-right">
                      <Link
                        href={`/payroll/transactions/tp1?employmentId=${r.employmentId}`}
                        className="text-sm font-medium text-primary hover:underline"
                      >
                        {t('tp1.open')}
                      </Link>
                    </td>
                  </tr>
                ))}
                {rows.length === 0 && (
                  <tr>
                    <td colSpan={5} className="px-4 py-8 text-center text-muted-foreground">
                      {t('tp1.noResults')}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
          <Pager
            basePath="/payroll/transactions/tp1"
            params={{ q, companyId, departmentId }}
            state={pageState(pq, total, rows.length)}
          />
        </Card>
      )}
    </>
  );
}

/** The selected employee's declaration: header + year selector + the SHARED per-category form. */
async function EmployeeDeclaration({
  s,
  subject,
  spYear,
}: {
  s: Awaited<ReturnType<typeof scopedAdmin>>['s'];
  subject: NonNullable<Awaited<ReturnType<typeof employmentSubject>>>;
  spYear?: string;
}) {
  const t = await getTranslations('payroll.transactions');
  const tr = await getTranslations('taxRelief');

  const currentYear = new Date().getFullYear();
  const years = await listTp1YearsForPerson(s, { personId: subject.personId });
  const yearOptions = Array.from(new Set([currentYear, ...years])).sort((a, b) => b - a);
  const selectedYear = spYear && /^\d{4}$/.test(spYear) ? Number(spYear) : currentYear;

  const latest = await getTp1ForPerson(s, { personId: subject.personId, assessmentYear: selectedYear });
  const readOnly = selectedYear < currentYear; // a past assessment year is a read-only historical view

  return (
    <>
      {/* Selected-employee header (mirrors the ESS employee header) + change-employee link. */}
      <Card className="p-5">
        <div className="flex items-start justify-between">
          <h2 className="text-sm font-semibold">{tr('employeeSection')}</h2>
          <Link href="/payroll/transactions/tp1" className="text-sm font-medium text-primary hover:underline">
            {t('tp1.changeEmployee')}
          </Link>
        </div>
        <dl className="mt-3 grid grid-cols-1 gap-x-6 gap-y-3 sm:grid-cols-2">
          <div>
            <dt className="text-xs text-muted-foreground">{tr('employeeName')}</dt>
            <dd className="text-sm font-medium">{subject.name}</dd>
          </div>
          <div>
            <dt className="text-xs text-muted-foreground">{tr('employeeNumber')}</dt>
            <dd className="text-sm font-medium tabular-nums">{subject.employeeCode ?? '—'}</dd>
          </div>
          <div>
            <dt className="text-xs text-muted-foreground">{tr('company')}</dt>
            <dd className="text-sm font-medium">{subject.company}</dd>
          </div>
          <div>
            <dt className="text-xs text-muted-foreground">{t('tp1.departmentLabel')}</dt>
            <dd className="text-sm font-medium">{subject.department ?? '—'}</dd>
          </div>
        </dl>
      </Card>

      {/* Year selector — keeps the employment context via a hidden field. */}
      <Card className="p-5">
        <form method="GET" className="flex flex-wrap items-end gap-3">
          <input type="hidden" name="employmentId" value={subject.employmentId} />
          <label className="block text-sm">
            <span className="mb-1 block font-medium">{tr('yearLabel')}</span>
            <select name="year" defaultValue={String(selectedYear)} className={inputCls}>
              {yearOptions.map((y) => (
                <option key={y} value={y}>
                  {y}
                </option>
              ))}
            </select>
          </label>
          <Button type="submit" variant="secondary">
            {tr('viewYear')}
          </Button>
        </form>
      </Card>

      {/* Declaration — the SHARED form (identical to the ESS screen), writing on-behalf. */}
      <Tp1DeclarationForm
        selectedYear={selectedYear}
        latest={latest}
        readOnly={readOnly}
        saveDraftAction={adminSaveTp1Draft}
        submitAction={adminSubmitTp1}
        hiddenFields={{ employmentId: subject.employmentId }}
      />

      <p className="text-xs text-muted-foreground">{tr('historyNote')}</p>
    </>
  );
}
