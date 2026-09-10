import { getTranslations } from 'next-intl/server';

import { requireAdmin } from '@/lib/authz';
import { Button, PageHeader } from '@/components/ui';
import { LeaveConfigMap, leaveConfigScreenHref, leaveConfigScreenTitle } from '@/components/leave-config-map';
import { LeaveLedgerImport } from '../../leave/import/leave-ledger-import';

/**
 * a6fe37fc — IMPORT LEAVE DATA (`/admin/leave-config/import`).
 *
 * ⚠️ ROUND 5 (cutover) HAS HAPPENED: this IS the screen. `/admin/leave/import` is an unguarded redirect
 * stub pointing here, it has left lib/permissions.ts's leaveConfig `routes`, and the area map's
 * `importLeaveData` entry names this address. The stub is never deleted — bookmarks are why it exists.
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
 * THE HEADING IS THE MENU'S OWN STRING. `leaveConfigScreenTitle('importLeaveData')` renders the very
 * key `LeaveConfigMap` shows for this screen, so the menu and the page can never drift — the defect
 * IA §1.1 measured on four screens. The page's private `admin.leave.import.title` is no longer read
 * here; the namespace itself stays, because `leave-ledger-import.tsx` renders the rest of it.
 */
export default async function LeaveConfigImportPage() {
  const t = await getTranslations('admin.leave.import');
  await requireAdmin();

  return (
    <div className="space-y-6">
      {/* r259 — `back` resolves through the area map below rather than through a literal, so the
          back-link and the menu entry can never give two answers about where the leave type screen is.
          The old page carried the literal the map now owns (app/admin/leave/import/page.tsx). */}
      <PageHeader
        back={{ href: leaveConfigScreenHref('leaveTypes'), label: t('backLabel') }}
        title={await leaveConfigScreenTitle('importLeaveData')}
        description={t('description')}
        actions={
          <Button asChild>
            <a href="#leave-import-form">{t('uploadFile')}</a>
          </Button>
        }
      />
      {/* `current="importLeaveData"` because this IS that screen — the map names screens, not addresses. */}
      <LeaveConfigMap current="importLeaveData" />
      {/* F44 — validate then commit, MOUNTED. */}
      <LeaveLedgerImport />
    </div>
  );
}
