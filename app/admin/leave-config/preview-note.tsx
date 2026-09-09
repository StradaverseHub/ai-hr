import { getTranslations } from 'next-intl/server';

/**
 * a6fe37fc ROUND 3 — the one sentence every new leave-config screen owes the administrator.
 *
 * ⚠️ IT IS NOT DECORATION. Round 2's rule 2 stands for this round too: **no server action changes
 * signature and no new action is written.** Every leave action redirects to a module constant that still
 * names the OLD address (`ENTITLEMENTS`, `LEAVE`, `LEAVE_REPLACEMENT`, `ADJUSTMENTS`, `GENERATE`,
 * `ENTITLEMENT_TEMPLATES` — app/admin/_redirects.ts), so a save made on one of these screens lands on the
 * screen it will eventually replace. Re-pointing a redirect would move the save on the OLD screen too,
 * which is a Round 5 act (docs/design/a6fe37fc-migration-order.md).
 *
 * A screen that saves correctly and then navigates somewhere else reads as broken. Saying so out loud is
 * the difference between a known, temporary window and a bug report. The note goes at the cutover, with
 * the redirect constants it describes.
 *
 * SERVER COMPONENT, deliberately: one `getTranslations` and a paragraph, nothing crossing a boundary
 * (r123 took a production tab down by handing a closure across it; test/server-client-boundary.test.ts
 * pins the class).
 */
export async function LeaveConfigPreviewNote() {
  const t = await getTranslations('admin.leaveConfigPreview');
  return (
    <p className="rounded-lg border border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
      {t('note')}
    </p>
  );
}
