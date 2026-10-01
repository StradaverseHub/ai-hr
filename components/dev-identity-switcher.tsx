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
    // r374 — min-w-0 on BOTH the form (the flex item of the header's left cluster) and the <select>.
    // A <select>'s intrinsic width is its LONGEST option: measured at 216px against seeded principals,
    // which made this dev-only control the widest thing in the cluster and set a 369px floor under the
    // whole left track. The header's left side is the compressible one below md, so a child that
    // refuses to compress pushes the overflow back out of the header. Nothing here is a width floor.
    <form action={actAs} className="flex min-w-0 items-center gap-1.5">
      <span className="shrink-0 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
        {t('devAs')}
      </span>
      <select
        key={current}
        name="userId"
        defaultValue={current}
        onChange={(e) => e.currentTarget.form?.requestSubmit()}
        className="min-w-0 max-w-full rounded-md border border-input bg-background px-2 py-1 text-xs text-foreground focus:outline-none focus:ring-2 focus:ring-ring"
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
