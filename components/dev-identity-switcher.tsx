'use client';

import { useTranslations } from 'next-intl';
import { actAs } from '@/app/identity-actions';
import type { Principal } from '@/lib/principals';

/** DEV-ONLY: "act as" any seeded principal to exercise RBAC/ABAC. Submits on change. */
export function DevIdentitySwitcher({
  principals,
  current,
}: {
  principals: Principal[];
  current: string;
}) {
  const t = useTranslations('topbar');
  if (principals.length === 0) return null;
  return (
    <form action={actAs} className="flex items-center gap-1.5">
      <span className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">{t('devAs')}</span>
      <select
        key={current}
        name="userId"
        defaultValue={current}
        onChange={(e) => e.currentTarget.form?.requestSubmit()}
        className="rounded-md border border-input bg-background px-2 py-1 text-xs text-foreground focus:outline-none focus:ring-2 focus:ring-ring"
      >
        {principals.map((p) => (
          <option key={p.userId} value={p.userId}>
            {p.name} · {p.roles.join('/') || t('noRole')}
          </option>
        ))}
      </select>
    </form>
  );
}
