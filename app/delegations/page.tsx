import { getTranslations } from 'next-intl/server';
import { scopedSession } from '@/lib/scope';
import { PageHeader } from '@/components/ui';
import { DelegationManager } from '@/components/delegation-manager';
import { readDelegationPageContext } from './read-page-context';

/**
 * Global Delegation Management (Phase 1). A single screen listing who is covering approvals for whom, with
 * self-service (managers) and HR management (any employment, plus history). Server Component — it fetches
 * the initial context and renders the SHARED DelegationManager (popup parity, feedback 29fe2d45): the
 * command-bar popup renders the exact same component, so the full page is purely a larger workspace.
 * Save outcomes render inline from useActionState inside the manager (no ?error/?toast banners anymore);
 * ?history=1 is just the initial value of the manager's client-side history state, so old links keep
 * working. No sidebar entry (per the request).
 */
export default async function DelegationsPage({
  searchParams,
}: {
  searchParams: Promise<{ history?: string }>;
}) {
  const { history: historyParam } = await searchParams;
  const t = await getTranslations('delegations');
  // scopedSession (not a bare getSession) is the page guard the access matrix records: every authenticated
  // role reaches /delegations; the DATA is scoped in the reads (HR sees the tenant, a self-service user only
  // their own rows). We don't filter the delegation list by company scope — a delegation is a person↔person
  // handover, not a company-scoped list.
  const { s } = await scopedSession();
  const { initialContext, history } = await readDelegationPageContext(s, historyParam === '1');

  return (
    <div className="space-y-6">
      <PageHeader title={t('title')} description={t('subtitle')} />
      <DelegationManager surface="page" initialContext={initialContext} initialHistory={history} />
    </div>
  );
}
