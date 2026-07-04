import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { requireAdmin } from '@/lib/authz';
import { Card, PageHeader } from '@/components/ui';
import { PayrollTabs } from '@/components/payroll-tabs';

/**
 * Feature 2.0 — Payroll Configuration landing (information architecture over existing config surfaces).
 * Re-surfaces the already-wired payroll-config sub-modules as a card grid under the Payroll module,
 * modelled on the approved Feature 1.2 Transactions hub. Like that precedent we render ONLY the wired
 * destinations — no "coming soon" placeholders.
 *
 * No schema, no service, no DomainEvent (deliberate, not an omission): this page performs no writes.
 * Config *changes* are already audited by the destination services (core/payroll-config.ts,
 * core/pay-components.ts), so the audit / "only active settings" guarantees live there, not here.
 *
 * RBAC: gated by `requireAdmin()` exactly like the Transactions precedent. Every linked destination is
 * admin-reachable, so there is no per-card authorization — the only tier that reaches this hub is admin.
 *
 * Currency Rate is intentionally omitted (no FX-rate table/service exists yet — backlog item with its
 * own ADR + schema + service) rather than shown as a dead tile, per the no-placeholder precedent.
 */
export default async function PayrollSetupPage() {
  await requireAdmin();
  const t = await getTranslations('payroll.setup');

  const cards = [
    { key: 'policies', href: '/admin/payroll-config' },
    { key: 'items', href: '/admin/pay-components' },
    { key: 'payrollPolicies', href: '/admin/payroll-policy' },
    { key: 'loans', href: '/admin/loans' },
    { key: 'period', href: '/admin/payroll-config' },
    { key: 'submission', href: '/admin/payroll-config' },
    { key: 'ea', href: '/admin/pay-components' },
    { key: 'statutory', href: '/payroll/configuration' },
  ] as const;

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <PageHeader title={t('title')} description={t('subtitle')} />
      <PayrollTabs active="setup" />

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {cards.map((c) => (
          <Card key={`${c.key}-${c.href}`} className="flex flex-col p-5">
            <h2 className="text-base font-semibold">{t(`${c.key}.title`)}</h2>
            <p className="mt-1 flex-1 text-sm text-muted-foreground">{t(`${c.key}.desc`)}</p>
            <Link
              href={c.href}
              className="mt-4 inline-flex w-fit items-center rounded-lg bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
            >
              {t(`${c.key}.cta`)}
            </Link>
          </Card>
        ))}
      </div>
    </div>
  );
}
