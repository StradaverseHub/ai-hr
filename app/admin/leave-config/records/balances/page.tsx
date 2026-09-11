import { getTranslations } from 'next-intl/server';

import { requireAdmin } from '@/lib/authz';
import { listLeaveLedgerArchiveCaptures, listLeaveLedgerResetArchive } from '@/packs/leave/service';
import { Card, PageHeader, btnPrimary, inputCls } from '@/components/ui';
import { LeaveConfigMap, leaveConfigPageHeader } from '@/components/leave-config-map';

/**
 * a6fe37fc — THE MEDICAL / HOSPITALISATION BALANCE RECORD (`/admin/leave-config/records/balances`).
 * IA §2 → RECORDS › balance record.
 *
 * ⚠️ ROUND 5 (cutover) HAS HAPPENED: this IS the screen. `/admin/leave/entitlements/ledger-archive` is an
 * unguarded redirect stub pointing here, it has left lib/permissions.ts's leaveConfig `routes`, and the
 * map's `ledgerArchive` entry names this address. The stub is never deleted.
 *
 * WHAT IT IS (c8052ae3, unchanged): "Before anything is removed, copy every affected record into a
 * permanent written record you can read on screen and download, so the old figures are never lost." This
 * screen is the "read on screen" half; the CSV beside it is the other. It matters more than the
 * configuration record it is modelled on: that one recorded settings somebody could retype, this one
 * records 147 grants to named employees taken out of a ledger documented as APPEND-ONLY.
 *
 * READ-ONLY BY CONSTRUCTION: no mutating form, no server action — and, unlike the configuration record,
 * NO RE-CAPTURE BUTTON EITHER. The capture runs once, inside the correction script's own transaction,
 * before the rows are deleted; a re-capture offered here could only ever run AFTER they are gone and
 * would write an empty snapshot over the only copy. That absence is a feature and it is carried across
 * with the screen. Nothing here saves, so this page needs no preview note.
 *
 * ⚠️ THE CSV LINK STILL POINTS AT THE OLD `/export` ROUTE HANDLER, AND IT STAYS THERE. A route handler
 * has no screen column, was never in lib/permissions.ts, and nothing about the cutover requires it to
 * move — re-addressing it would break every saved download link and buy nothing.
 *
 * F46 IS THE WHOLE OF THIS SCREEN and it is carried complete: the capture picker, the two counts stated
 * plainly, the eight-column listing, the "no leave request behind this row" line on every ledger row, and
 * the CSV.
 *
 * THE HEADING IS THE MENU'S OWN STRING (`leaveConfigScreenTitle('ledgerArchive')`). The old page owned a
 * private `admin.leaveLedgerArchive.pageTitle` reading "Medical & Hospitalisation balance record" while
 * the menu called the same screen "Ledger archive" — one of the four mismatches IA §1.1 measured. The key
 * is DELETED in all six locales with the page that owned it. The sentence it used to say is not lost: the
 * `pageDescription` and the intro below both still say in full what this record is of.
 */
export default async function LeaveConfigBalanceRecordPage({
  searchParams,
}: {
  searchParams: Promise<{ capture?: string }>;
}) {
  const s = await requireAdmin();
  const t = await getTranslations('admin.leaveLedgerArchive');
  const sp = await searchParams;

  const captures = await listLeaveLedgerArchiveCaptures(s);
  // An unknown ?capture is ignored rather than rendering an empty table for a tag that does not exist.
  const chosen = captures.find((c) => c.captureTag === sp.capture)?.captureTag ?? captures[0]?.captureTag;
  const rows = await listLeaveLedgerResetArchive(s, { captureTag: chosen });

  const dash = '—';
  const csvHref = chosen
    ? `/admin/leave/entitlements/ledger-archive/export?capture=${encodeURIComponent(chosen)}`
    : '/admin/leave/entitlements/ledger-archive/export';

  const ledgerCount = rows.filter((r) => r.layer === 'ledger').length;
  const auditCount = rows.length - ledgerCount;

  // 10b59703 — a TAB of Leave Adjustments ("Balance record", one name from now on; the pill called it
  // "Ledger archive"). It is a record of ledger rows a reset removed — the same kind of row an
  // adjustment writes — so it sits beside the adjustment. Heading and description are the row's; the
  // tab's own sentence leads the intro card.
  const header = await leaveConfigPageHeader('ledgerArchive');

  return (
    <div className="space-y-6">
      <PageHeader title={header.title} description={header.description} />
      {/* `current="ledgerArchive"` because this IS that tab of the Leave Adjustments row. */}
      <LeaveConfigMap current="ledgerArchive" />

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
              so the picker works here exactly as it does on the old screen. */}
          <form className="flex flex-wrap items-end gap-3 border-b p-4">
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
            {/* 10b59703 — the back-link to the leave type screen stood here and is gone: this is a tab of
                Leave Adjustments now, and the row stays lit on it. */}
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
