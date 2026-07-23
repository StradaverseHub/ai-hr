import { getTranslations } from 'next-intl/server';
import { requireAdmin } from '@/lib/authz';
import { listLeaveTypes } from '@/core/read';
import { Card, ErrorBanner, PageHeader, SectionHeader } from '@/components/ui';
import { ConfirmSubmit } from '@/components/ui/confirm-submit';
import { LeaveTabs } from '@/components/leave-tabs';
import { deleteLeaveTypeAction } from '../actions';

/**
 * Leave Settings — Leave Types tab.
 *
 * Feedback 9d8cf621 (Entitlements Setting reorganization) moved the per-type CONFIGURATION panel — leave-type
 * identity, eligibility, durations, supporting-document, backdating, advance-notice, expiry, apply-time
 * message AND the per-type entitlement policies — off this tab and onto the Entitlements tab (`entitlements/`),
 * where HR expects "one leave type, one full set of settings". This tab keeps the read-only master listing
 * (identity / status); every Edit link jumps to the config panel on the Entitlements tab
 * (`/admin/leave/entitlements#type-<id>`). Feedback 26e76a9f then removed the read-only "Entitlement rules"
 * card (effective-rules overview + resolution order) that used to sit below the master listing — it duplicated
 * what the Entitlements tab already manages and read like a second place to configure entitlements. The live
 * "preview a scenario" checker relocated to the Entitlements tab. Display-only removal: no entitlement
 * records, calculations, balances or configuration logic changed — the master-table delete keeps its existing
 * server action.
 */
export default async function LeaveTypesPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const s = await requireAdmin();
  const t = await getTranslations('admin.leave');
  const { error } = await searchParams;
  const types = await listLeaveTypes(s, { includeArchived: true });

  return (
    <div className="space-y-6">
      <PageHeader title={t('pageTitle')} description={t('pageDescription')} />
      <LeaveTabs active="types" />
      <ErrorBanner message={error} />

      {/* Leave Type master page (feedback 097de541) — read-only master listing. Edit jumps to the per-type
          config panel on the Entitlements tab (feedback 9d8cf621). */}
      <Card>
        <SectionHeader title={t('typeMasterTitle')} count={types.length} />
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b border-border text-left text-muted-foreground">
                <th className="px-4 py-2 font-medium">{t('colName')}</th>
                <th className="px-4 py-2 font-medium">{t('colCode')}</th>
                <th className="px-4 py-2 font-medium">{t('colPaid')}</th>
                <th className="px-4 py-2 font-medium">{t('colDescription')}</th>
                <th className="px-4 py-2 font-medium">{t('colStatus')}</th>
                <th className="px-4 py-2 text-right font-medium">{t('colActions')}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border/60">
              {types.length === 0 && (
                <tr>
                  <td colSpan={6} className="px-4 py-6 text-center text-muted-foreground">
                    {t('noLeaveTypes')}
                  </td>
                </tr>
              )}
              {types.map((lt) => {
                const isActive = !lt.archivedAt;
                return (
                  <tr key={lt.id} className={isActive ? '' : 'opacity-60'}>
                    <td className="px-4 py-2 font-medium text-foreground">{lt.name}</td>
                    <td className="px-4 py-2 text-muted-foreground">{lt.code}</td>
                    <td className="px-4 py-2 text-muted-foreground">
                      {lt.paid ? t('paidValue') : t('unpaidValue')}
                    </td>
                    <td className="px-4 py-2 text-muted-foreground">{lt.description || '—'}</td>
                    <td className="px-4 py-2">
                      <span className="inline-flex items-center gap-1.5" title={isActive ? t('statusActive') : t('statusInactive')}>
                        <span
                          aria-hidden
                          className={`inline-block size-2 shrink-0 rounded-full ${isActive ? 'bg-emerald-500' : 'bg-red-500'}`}
                        />
                        <span className="sr-only">{isActive ? t('statusActive') : t('statusInactive')}</span>
                      </span>
                    </td>
                    <td className="px-4 py-2">
                      <div className="flex items-center justify-end gap-1">
                        <a
                          href={`/admin/leave/entitlements#type-${lt.id}`}
                          className="rounded-md px-2 py-1 text-foreground underline decoration-border hover:decoration-foreground"
                        >
                          {t('edit')}
                        </a>
                        {lt.inUse ? (
                          <button
                            type="button"
                            disabled
                            title={t('deleteInUseTooltip')}
                            className="cursor-not-allowed rounded-md px-2 py-1 text-muted-foreground/60"
                          >
                            {t('delete')}
                          </button>
                        ) : (
                          <form action={deleteLeaveTypeAction}>
                            <input type="hidden" name="id" value={lt.id} />
                            <ConfirmSubmit
                              size="sm"
                              variant="ghost"
                              className="text-destructive hover:text-destructive"
                              title={t('deleteTypeConfirmTitle')}
                              description={t('deleteTypeConfirmDescription')}
                              confirmLabel={t('deleteConfirmLabel')}
                            >
                              {t('delete')}
                            </ConfirmSubmit>
                          </form>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <p className="border-t border-border px-4 py-2.5 text-xs text-muted-foreground">
          {t('typeMasterConfigHint')}
        </p>
      </Card>
    </div>
  );
}
