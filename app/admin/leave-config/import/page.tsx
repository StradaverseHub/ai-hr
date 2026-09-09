import { getTranslations } from 'next-intl/server';

import { requireAdmin } from '@/lib/authz';
import { Button, PageHeader } from '@/components/ui';
import { LeaveConfigMap, leaveConfigScreenHref } from '@/components/leave-config-map';
import { LeaveLedgerImport } from '../../leave/import/leave-ledger-import';
import { LeaveConfigPreviewNote } from '../preview-note';

/**
 * a6fe37fc ROUND 3 — IMPORT LEAVE DATA at its new address (`/admin/leave-config/import`).
 *
 * ⚠️ IT REPLACES NOTHING YET. `/admin/leave/import` is untouched, still registered and still what the
 * menu links to; Round 5 empties that page and repoints its address here.
 *
 * ⚠️ THE IMPORTER IS NOT RE-IMPLEMENTED (IA §2.3). `LeaveLedgerImport` is the SAME client component the
 * old page mounts — F44's whole two-phase contract (validate, then commit) lives inside it, and a second
 * copy of an importer that writes the ledger is the last thing this item should produce.
 *
 * TRUSTED-HR-ADMIN ONLY, and the guard is the old page's verbatim `requireAdmin()`. There is deliberately
 * no company selector: the importer supports multi-company files but rejects or flags rows outside the
 * acting admin's authority at PREVIEW time (`analyze()`'s authority check), so narrowing the screen would
 * describe a restriction the engine does not apply.
 *
 * A COMMIT MADE HERE LANDS ON THE OLD SCREEN — see `../preview-note.tsx`.
 */
export default async function LeaveConfigImportPage() {
  const t = await getTranslations('admin.leave.import');
  await requireAdmin();

  return (
    <div className="space-y-6">
      {/* r259 — `back` is resolved through the area map below, which is the module's ONE navigation
          direction: OUT, at the screen that is live today, until Round 5 repoints the map. It read
          `/admin/leave-config/types`, which left this page telling the administrator two different things
          about where the leave type screen is. It is also the old page's own back-link, character for
          character (app/admin/leave/import/page.tsx). */}
      <PageHeader
        back={{ href: leaveConfigScreenHref('leaveTypes'), label: t('backLabel') }}
        title={t('title')}
        description={t('description')}
        actions={
          <Button asChild>
            <a href="#leave-import-form">{t('uploadFile')}</a>
          </Button>
        }
      />
      {/* `current="importLeaveData"` because this IS that screen — the map names screens, not addresses. */}
      <LeaveConfigMap current="importLeaveData" />
      <LeaveConfigPreviewNote />
      {/* F44 — validate then commit, MOUNTED. */}
      <LeaveLedgerImport />
    </div>
  );
}
