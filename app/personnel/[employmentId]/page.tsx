import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { getSession } from '@/lib/session';
import { isAdmin } from '@/lib/authz';
import { employeeDetail, assignmentHistory } from '@/core/read';
import { deriveEmploymentStatus } from '@/core/employment-status';
import { Avatar, Card, EmployeeName, PageHeader, StatusBadge } from '@/components/ui';

/**
 * Read-only staff-directory profile (People→Personnel split). Shows only directory-safe fields —
 * name, role (department / position / grade), work contact, status. No pay, statutory, or personal
 * data, and no edit affordances; all management lives behind /admin/personnel. RLS scopes the read,
 * so a viewer who cannot see this employment gets a 404 rather than a leak. Admins get a shortcut to
 * the full management record.
 */
export default async function PersonnelDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ employmentId: string }>;
  searchParams: Promise<{ from?: string }>;
}) {
  const s = await getSession();
  const t = await getTranslations('people.detail');
  const { employmentId } = await params;
  const { from } = await searchParams;
  const admin = isAdmin(s);
  const back =
    from === 'org'
      ? { href: '/org', label: t('backToOrg') }
      : { href: '/personnel', label: t('backToPeople') };

  const emp = await employeeDetail(s, employmentId);
  if (!emp) notFound();
  const history = await assignmentHistory(s, employmentId);
  const current = history.find((h) => h.validTo == null) ?? history[0] ?? null;

  // Employee Status sync (5afcda91): same system-derived status as every other Personnel screen —
  // deriveEmploymentStatus over the lifecycle dates (employeeDetail already projects them all), so the
  // same employee reads the same status here, on the directory, and on the admin record.
  const tStatus = await getTranslations('people.employeeStatus');
  const today = new Date().toISOString().slice(0, 10);
  const derivedStatus = deriveEmploymentStatus(emp, today);

  const rows: { label: string; value: string | null }[] = [
    { label: t('department'), value: current?.department ?? null },
    { label: t('position'), value: current?.position ?? null },
    { label: t('grade'), value: emp.gradeName ?? null },
    { label: t('email'), value: emp.email },
    { label: t('phone'), value: emp.phone },
  ];

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <PageHeader
        title={emp.name}
        description={t('directorySubtitle')}
        back={back}
        actions={
          admin ? (
            <Link
              href={`/admin/personnel/${employmentId}`}
              className="rounded-lg border border-border px-3 py-1.5 text-sm font-medium text-foreground transition-colors hover:bg-accent"
            >
              {t('viewFullRecord')}
            </Link>
          ) : undefined
        }
      />

      <Card className="p-6">
        <div className="flex items-center gap-4">
          <Avatar name={emp.name} className="size-12 text-base" />
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              {/* Employee ID left-of-name (feedback 38668d9b) */}
              <EmployeeName code={emp.employeeCode} name={emp.name} className="text-lg font-semibold" codeClassName="text-sm" />
              <StatusBadge status={derivedStatus} label={tStatus(derivedStatus)} />
            </div>
            <div className="text-sm text-muted-foreground">{emp.company}</div>
          </div>
        </div>

        <dl className="mt-6 grid grid-cols-1 gap-x-8 gap-y-3 sm:grid-cols-2">
          {rows.map((r) => (
            <div key={r.label} className="flex flex-col">
              <dt className="text-xs uppercase tracking-wide text-muted-foreground">{r.label}</dt>
              <dd className="text-sm text-foreground">{r.value ?? '—'}</dd>
            </div>
          ))}
        </dl>
      </Card>
    </div>
  );
}
