import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { scopedSession } from '@/lib/scope';
import { listCompanies, listDepartments, listEmployeesPage } from '@/core/read';
import { Avatar, Button, Card, EmployeeCode, PageHeader, StatusBadge, inputCls } from '@/components/ui';

const PAGE = 25;

/**
 * Read-only staff directory (People→Personnel split). Every employee can browse colleagues by
 * name / department / company / work contact — no pay, statutory, or personal data, and no admin
 * affordances (hire form, profile-change queue, CSV import, compensation). Those live behind
 * /admin/personnel. RLS still scopes every read to what this viewer is allowed to see.
 */
export default async function PersonnelPage({
  searchParams,
}: {
  searchParams: Promise<{
    q?: string;
    page?: string;
    company?: string;
    dept?: string;
    status?: string;
    type?: string;
  }>;
}) {
  const t = await getTranslations('people.list');
  const { s: session, scopeIds } = await scopedSession();
  const { q, page: pageParam, company, dept, status, type } = await searchParams;
  const page = Math.max(0, Number(pageParam) || 0);
  const statusFilter = status === 'active' || status === 'terminated' ? status : undefined;
  const hasFilters = !!(q || company || dept || status || type);
  const [{ rows: employees, total }, companies, departments] = await Promise.all([
    listEmployeesPage(session, {
      companyIds: scopeIds,
      q,
      companyId: company || undefined,
      departmentId: dept || undefined,
      status: statusFilter,
      employmentType: type || undefined,
      limit: PAGE,
      offset: page * PAGE,
    }),
    listCompanies(session),
    listDepartments(session),
  ]);
  const hasNext = (page + 1) * PAGE < total;
  const qs = (over: Record<string, string | number | undefined>) => {
    const merged: Record<string, string | number | undefined> = { q, company, dept, status, type, page: pageParam, ...over };
    const sp = new URLSearchParams();
    for (const [k, v] of Object.entries(merged)) if (v) sp.set(k, String(v));
    const s = sp.toString();
    return s ? `/personnel?${s}` : '/personnel';
  };
  const EMPLOYMENT_TYPES = [
    { value: 'full_time', labelKey: 'employmentFullTime' },
    { value: 'part_time', labelKey: 'employmentPartTime' },
    { value: 'contract', labelKey: 'employmentContract' },
    { value: 'intern', labelKey: 'employmentIntern' },
  ] as const;

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <PageHeader
        title={t('title')}
        actions={<span className="text-sm text-muted-foreground">{t('employeeCount', { count: total })}</span>}
      />

      <form method="get" className="flex flex-wrap items-center gap-2">
        <input
          name="q"
          defaultValue={q ?? ''}
          placeholder={t('searchPlaceholder')}
          className={`${inputCls} max-w-xs`}
          aria-label={t('searchAriaLabel')}
        />
        <select name="company" defaultValue={company ?? ''} aria-label={t('filterCompany')} className={`${inputCls} w-auto`}>
          <option value="">{t('allCompanies')}</option>
          {companies.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
        <select name="dept" defaultValue={dept ?? ''} aria-label={t('filterDepartment')} className={`${inputCls} w-auto`}>
          <option value="">{t('allDepartments')}</option>
          {departments.map((d) => (
            <option key={d.id} value={d.id}>
              {d.name}
            </option>
          ))}
        </select>
        <select name="status" defaultValue={status ?? ''} aria-label={t('filterStatus')} className={`${inputCls} w-auto`}>
          <option value="">{t('allStatuses')}</option>
          <option value="active">{t('statusActive')}</option>
          <option value="terminated">{t('statusTerminated')}</option>
        </select>
        <select name="type" defaultValue={type ?? ''} aria-label={t('filterType')} className={`${inputCls} w-auto`}>
          <option value="">{t('allTypes')}</option>
          {EMPLOYMENT_TYPES.map((et) => (
            <option key={et.value} value={et.value}>
              {t(et.labelKey)}
            </option>
          ))}
        </select>
        <Button type="submit" variant="secondary" size="sm">
          {t('search')}
        </Button>
        {hasFilters && (
          <Link href="/personnel" className="text-sm text-muted-foreground hover:text-foreground">
            {t('clear')}
          </Link>
        )}
      </form>

      <Card className="overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-muted/50 text-left text-xs uppercase tracking-wide text-muted-foreground">
            <tr>
              <th className="px-4 py-3 font-medium">{t('colCode')}</th>
              <th className="px-4 py-3 font-medium">{t('colName')}</th>
              <th className="px-4 py-3 font-medium">{t('colDepartment')}</th>
              <th className="px-4 py-3 font-medium">{t('colCompany')}</th>
              <th className="px-4 py-3 font-medium">{t('colStatus')}</th>
              <th className="px-4 py-3 font-medium">{t('colHired')}</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {employees.map((e) => (
              <tr key={e.employmentId} className="hover:bg-muted/40">
                <td className="px-4 py-3">
                  <EmployeeCode code={e.employeeCode} />
                </td>
                <td className="px-4 py-3">
                  <div className="flex items-center gap-3">
                    <Avatar name={e.name} />
                    <div className="min-w-0">
                      <Link
                        href={`/personnel/${e.employmentId}`}
                        className="font-medium text-foreground hover:text-primary"
                      >
                        {e.name}
                      </Link>
                      <div className="truncate text-xs text-muted-foreground">{e.email}</div>
                    </div>
                  </div>
                </td>
                <td className="px-4 py-3 text-muted-foreground">{e.department ?? '—'}</td>
                <td className="px-4 py-3 text-muted-foreground">{e.company}</td>
                <td className="px-4 py-3">
                  <StatusBadge status={e.terminatedOn ? 'terminated' : e.status} />
                </td>
                <td className="px-4 py-3 text-muted-foreground">{e.hiredOn}</td>
              </tr>
            ))}
            {employees.length === 0 && (
              <tr>
                <td colSpan={6} className="px-4 py-10 text-center text-muted-foreground">
                  {q ? t('emptySearch', { q }) : hasFilters ? t('emptyFiltered') : t('emptyNoEmployees')}
                </td>
              </tr>
            )}
          </tbody>
        </table>
        {(page > 0 || hasNext) && (
          <div className="flex items-center justify-between border-t border-border px-4 py-3 text-sm">
            {page > 0 ? (
              <Link href={qs({ page: page - 1 || undefined })} className="text-primary hover:underline">
                {t('newer')}
              </Link>
            ) : (
              <span />
            )}
            <span className="text-xs text-muted-foreground">
              {t('rangeOf', {
                from: page * PAGE + 1,
                to: Math.min((page + 1) * PAGE, total),
                total,
              })}
            </span>
            {hasNext ? (
              <Link href={qs({ page: page + 1 })} className="text-primary hover:underline">
                {t('older')}
              </Link>
            ) : (
              <span />
            )}
          </div>
        )}
      </Card>
    </div>
  );
}
