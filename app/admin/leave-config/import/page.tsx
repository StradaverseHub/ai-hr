import { getTranslations } from 'next-intl/server';

import { requireAdmin } from '@/lib/authz';
import { Button, PageHeader } from '@/components/ui';
import { LeaveConfigMap, leaveConfigPageHeader } from '@/components/leave-config-map';
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
  // 10b59703 — a TAB of Leave Adjustments. What the importer loads is balance MOVEMENTS (opening
  // balances, carry-forward, ad-hoc credits — leave_ledger rows), the same kind of entry an adjustment
  // writes, so it moved out of the Entitlements header and under this row. The heading and description
  // are the row's; the back-link is gone with the header button that fed it.
  //
  // 3f15ffdb (r362) — THIS TAB IS CALLED "LEAVE BALANCE IMPORT" NOW, and the wording above used to say
  // it loaded "historical leave" too. That sentence is retired because it is no longer the whole truth
  // and was never quite the right one: this tool moves the BALANCE and leaves no record behind. Past
  // leave RECORDS are loaded by its sibling row, Leave History Data Import
  // (app/admin/leave-config/history-import), which writes leave_request rows and moves no balance.
  // Only the LABEL changed here — the screen id, the route and every stored role config are untouched.
  const header = await leaveConfigPageHeader('importLeaveData');

  return (
    <div className="space-y-6">
      <PageHeader
        title={header.title}
        description={header.description}
        actions={
          <Button asChild>
            <a href="#leave-import-form">{t('uploadFile')}</a>
          </Button>
        }
      />
      {/* `current="importLeaveData"` because this IS that tab of the Leave Adjustments row. */}
      <LeaveConfigMap current="importLeaveData" />
      {/* The tab's own sentence — what the file holds and what happens to it — now that the header
          carries the row's. */}
      <p className="text-sm text-muted-foreground">{t('description')}</p>
      {/* F44 — validate then commit, MOUNTED. */}
      <LeaveLedgerImport />
    </div>
  );
}
