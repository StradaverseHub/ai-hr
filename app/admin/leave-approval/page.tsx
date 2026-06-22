import { getTranslations } from 'next-intl/server';
import { scopedSession } from '@/lib/scope';
import { listCompanies } from '@/core/read';
import { getLeaveApprovalPolicy } from '@/core/leave-approval-policy';
import { Card, ErrorBanner, PageHeader, SectionHeader } from '@/components/ui';
import { LeaveApprovalEditor } from './editor';
import { saveLeaveApprovalPolicyAction } from './actions';

/** ADR-0039 2B-2 — per-company leave approval chain editor. Mirrors /admin/payroll-config: one card per
 *  company in scope; RLS already trims the list to companies the admin manages. */
export default async function LeaveApprovalPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const { s, scopeIds } = await scopedSession();
  const t = await getTranslations('leaveApproval');
  const { error } = await searchParams;

  const all = await listCompanies(s);
  const companies = all.filter((c) => scopeIds.includes(c.id));
  const rows = await Promise.all(
    companies.map(async (c) => ({ company: c, pol: await getLeaveApprovalPolicy(s, c.id) })),
  );
  const labels = {
    enable: t('enable'),
    enableHint: t('enableHint'),
    chain: t('chain'),
    empty: t('empty'),
    manager: t('manager'),
    hr: t('hr'),
    add: t('add'),
    moveUp: t('moveUp'),
    moveDown: t('moveDown'),
    remove: t('remove'),
    save: t('save'),
  };

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <PageHeader title={t('title')} description={t('description')} />
      {error && <ErrorBanner message={error} />}

      {companies.length === 0 ? (
        <Card>
          <p className="px-4 py-8 text-center text-sm text-muted-foreground">{t('emptyScope')}</p>
        </Card>
      ) : (
        rows.map(({ company, pol }) => (
          <Card key={company.id}>
            <SectionHeader title={company.name} />
            <LeaveApprovalEditor
              companyId={company.id}
              action={saveLeaveApprovalPolicyAction}
              initialEnabled={pol.enabled}
              initialLevels={pol.levels}
              labels={labels}
            />
          </Card>
        ))
      )}
    </div>
  );
}
