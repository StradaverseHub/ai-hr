import { getTranslations } from 'next-intl/server';

import type { SessionContext } from '@/db/client';
import { listLeaveLedgerArchiveCaptures, listLeaveLedgerResetArchive } from '@/packs/leave/service';
import { Card, btnPrimary, inputCls } from '@/components/ui';

/**
 * 7f69bd71 — THE BALANCE RECORD, as the second sub-tab of the Reset records sub-screen
 * (`/admin/leave-config/records?record=balances`).
 *
 * THIS IS THE BODY OF `app/admin/leave-config/records/balances/page.tsx` MOVED, NOT REWRITTEN: the intro
 * card, the "Record taken" picker with Show and Download as CSV, the two counts stated plainly, and the
 * eight-column listing — exactly what the Leave Adjustments tab showed until this round. The page that
 * owned it is a redirect stub now. The one thing that DID change is the wording of the intro card
 * (`admin.leaveLedgerArchive.pageDescription` / `intro` / `emptyBody`): it described only the August
 * Medical / Hospitalisation reset, and the record has held the 2026-09-11 clearing of every generated
 * balance since fe9c73bc ran, so it now describes whichever reset the picker is on.
 *
 * WHAT IT IS (c8052ae3, unchanged): "Before anything is removed, copy every affected record into a
 * permanent written record you can read on screen and download, so the old figures are never lost."
 * This is the "read on screen" half; the CSV beside it is the other. It matters more than the
 * configuration record it is modelled on: that one recorded settings somebody could retype, this one
 * records grants to named employees taken out of a ledger documented as APPEND-ONLY.
 *
 * READ-ONLY BY CONSTRUCTION: no mutating form, no server action — and, unlike the configuration record,
 * NO RE-CAPTURE BUTTON EITHER. The capture runs once, inside the reset's own transaction, before the rows
 * are deleted; a re-capture offered here could only ever run AFTER they are gone and would write an empty
 * snapshot over the only copy. That absence is a feature and it is carried across with the record. The
 * only `<form>` is a GET carrying a hidden `record` field so Show keeps this sub-tab.
 *
 * ⚠️ THE CSV LINK STILL POINTS AT THE OLD `/export` ROUTE HANDLER, AND IT STAYS THERE. A route handler
 * has no screen column, was never in lib/permissions.ts, and re-addressing it would break every saved
 * download link and buy nothing.
 *
 * SERVER COMPONENT, and it must stay one: plain markup, one `getTranslations`, only serialisable props
 * (test/server-client-boundary.test.ts). F46 IS THE WHOLE OF THIS COMPONENT and it is carried complete.
 */
export async function ResetRecordBalances({ s, capture }: { s: SessionContext; capture?: string }) {
  const t = await getTranslations('admin.leaveLedgerArchive');

  const captures = await listLeaveLedgerArchiveCaptures(s);
  // An unknown ?capture is ignored rather than rendering an empty table for a tag that does not exist.
  const chosen = captures.find((c) => c.captureTag === capture)?.captureTag ?? captures[0]?.captureTag;
  const rows = await listLeaveLedgerResetArchive(s, { captureTag: chosen });

  const dash = '—';
  const csvHref = chosen
    ? `/admin/leave/entitlements/ledger-archive/export?capture=${encodeURIComponent(chosen)}`
    : '/admin/leave/entitlements/ledger-archive/export';

  const ledgerCount = rows.filter((r) => r.layer === 'ledger').length;
  const auditCount = rows.length - ledgerCount;

  return (
    <div className="space-y-6">
      <Card>
        <div className="space-y-3 p-4 text-sm">
          <p className="font-medium text-foreground">{t('pageDescription')}</p>
          <p className="text-muted-foreground">{t('intro')}</p>
          {/* The sentence people most need to read twice, and truer here than on the configuration
              record: these rows were DELETED, not superseded. */}
          <p className="font-medium">{t('notAnUndo')}</p>
          <p className="text-muted-foreground">{t('feedsNothing')}</p>
          <p className="text-muted-foreground">{t('noLeaveHistory')}</p>
        </div>
      </Card>

      {captures.length === 0 ? (
        <Card>
          <div className="space-y-2 p-6 text-sm">
            <p className="font-medium">{t('emptyTitle')}</p>
            <p className="text-muted-foreground">{t('emptyBody')}</p>
          </div>
        </Card>
      ) : (
        <Card>
          {/* A GET form with no `action`: it re-reads whatever address it is on with a different capture,
              and the hidden `record` keeps Show on THIS sub-tab. */}
          <form className="flex flex-wrap items-end gap-3 border-b p-4">
            <input type="hidden" name="record" value="balances" />
            <label className="flex flex-col gap-1 text-sm">
              <span className="text-muted-foreground">{t('captureLabel')}</span>
              <select name="capture" defaultValue={chosen ?? ''} className={inputCls}>
                {captures.map((c) => (
                  <option key={c.captureTag} value={c.captureTag}>
                    {c.captureTag} · {c.capturedAt.toISOString().slice(0, 10)} · {c.rows}
                  </option>
                ))}
              </select>
            </label>
            <button type="submit" className={btnPrimary}>
              {t('show')}
            </button>
            <a href={csvHref} className="text-sm underline">
              {t('downloadCsv')}
            </a>
          </form>

          {/* The two counts stated plainly: the whole point of the record is that the number of rows taken
              away is checkable, not asserted. */}
          <p className="border-b px-4 py-2 text-sm text-muted-foreground">
            {t('counts', { ledger: ledgerCount, audit: auditCount })}
          </p>

          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="bg-muted/40 text-xs uppercase text-muted-foreground">
                <tr>
                  <th className="px-3 py-2">{t('colLayer')}</th>
                  <th className="px-3 py-2">{t('colEmployee')}</th>
                  <th className="px-3 py-2">{t('colLeaveType')}</th>
                  <th className="px-3 py-2">{t('colEntryType')}</th>
                  <th className="px-3 py-2">{t('colDays')}</th>
                  <th className="px-3 py-2">{t('colEffectiveOn')}</th>
                  <th className="px-3 py-2">{t('colReason')}</th>
                  <th className="px-3 py-2">{t('colNote')}</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id} className="border-t align-top">
                    <td className="whitespace-nowrap px-3 py-2">
                      {r.layer === 'ledger' ? t('layerLedger') : t('layerRecalcAudit')}
                    </td>
                    <td className="px-3 py-2">
                      {r.employeeName ?? dash}
                      {r.employeeCode ? (
                        <span className="block text-xs text-muted-foreground">{r.employeeCode}</span>
                      ) : null}
                      {r.companyName ? (
                        <span className="block text-xs text-muted-foreground">{r.companyName}</span>
                      ) : null}
                    </td>
                    <td className="px-3 py-2">
                      {r.leaveTypeName ?? dash}
                      {r.leaveTypeCode ? (
                        <span className="block text-xs text-muted-foreground">{r.leaveTypeCode}</span>
                      ) : null}
                    </td>
                    <td className="whitespace-nowrap px-3 py-2">{r.entryType ?? dash}</td>
                    <td className="whitespace-nowrap px-3 py-2 tabular-nums">{r.daysText ?? dash}</td>
                    <td className="whitespace-nowrap px-3 py-2">{r.effectiveOnText ?? dash}</td>
                    <td className="px-3 py-2 text-xs text-muted-foreground">
                      {r.reason ?? dash}
                      {r.entitlementText ? <span className="block">{r.entitlementText}</span> : null}
                      {/* Stated rather than left blank: "no leave request behind this row" is the fact the
                          whole correction rests on, so it is written out on every ledger row. */}
                      {r.layer === 'ledger' ? (
                        <span className="block">{r.sourceRequestText ?? t('noRequest')}</span>
                      ) : null}
                    </td>
                    <td className="px-3 py-2 text-xs text-muted-foreground">{r.note ?? ''}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}
    </div>
  );
}
