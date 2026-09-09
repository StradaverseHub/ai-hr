import Link from 'next/link';
import { getTranslations } from 'next-intl/server';

import { requireAdmin } from '@/lib/authz';
import { listEntitlementArchiveCaptures, listEntitlementResetArchive } from '@/packs/leave/service';
import { Card, PageHeader, btnPrimary, inputCls } from '@/components/ui';
import { LeaveConfigMap, leaveConfigScreenHref } from '@/components/leave-config-map';

/**
 * a6fe37fc ROUND 3 — THE ENTITLEMENT CONFIGURATION RECORD at its new address
 * (`/admin/leave-config/records/entitlement`). IA §2 → RECORDS › Entitlement configuration record.
 *
 * ⚠️ IT REPLACES NOTHING YET. `/admin/leave/entitlements/archive` is untouched, still registered and
 * still what the menu links to; Round 5 empties that page and repoints its address here.
 *
 * WHAT IT IS (6e9a126e, unchanged): the approved plan promised the reporter "a read-only listing inside
 * your admin screens that you can open and download, so you read the old figures off it while you retype
 * them rather than working from memory. It feeds nothing and changes no number." This screen is that
 * sentence, at a second address, for one round.
 *
 * READ-ONLY BY CONSTRUCTION: no form that mutates, no server action, no import of one. The only `<form>`
 * on the page is a GET that re-reads the page with a different `?capture=` — which is why this file needs
 * no preview note: nothing here saves, so nothing here can navigate somewhere surprising after saving.
 *
 * ⚠️ THE CSV LINK STILL POINTS AT THE OLD `/export` ROUTE HANDLER, ON PURPOSE. IA §3.2 F45 says the
 * handler moves WITH the screen — in Round 5. This round adds and removes nothing, so pointing at a
 * handler that does not exist yet would ship a download button that 404s.
 *
 * F45 IS THE WHOLE OF THIS SCREEN and it is carried complete: the capture picker, the nine-column
 * listing, the "not an undo" sentence, and the CSV.
 */
export default async function LeaveConfigEntitlementRecordPage({
  searchParams,
}: {
  searchParams: Promise<{ capture?: string }>;
}) {
  const s = await requireAdmin();
  const t = await getTranslations('admin.entitlementArchive');
  const sp = await searchParams;

  const captures = await listEntitlementArchiveCaptures(s);
  // An unknown ?capture is ignored rather than rendering an empty table for a tag that does not exist.
  const chosen = captures.find((c) => c.captureTag === sp.capture)?.captureTag ?? captures[0]?.captureTag;
  const rows = await listEntitlementResetArchive(s, { captureTag: chosen });

  const dash = '—';
  const csvHref = chosen
    ? `/admin/leave/entitlements/archive/export?capture=${encodeURIComponent(chosen)}`
    : '/admin/leave/entitlements/archive/export';

  return (
    <div className="space-y-6">
      {/* The SAME heading the old screen renders: "same behaviour at a new address" (IA §3) means the
          administrator must not have to learn a second name for one record. */}
      <PageHeader title={t('pageTitle')} description={t('pageDescription')} />
      {/* `current="entitlementArchive"` because this IS that screen — the map names screens, not
          addresses, and Round 5 repoints the entry here. */}
      <LeaveConfigMap current="entitlementArchive" />

      <Card>
        <div className="space-y-3 p-4 text-sm">
          <p className="text-muted-foreground">{t('intro')}</p>
          {/* The sentence people most need to read twice: the record is a listing to retype from, not an
              undo button. */}
          <p className="font-medium">{t('notAnUndo')}</p>
          <p className="text-muted-foreground">{t('feedsNothing')}</p>
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
          {/* A GET form — it re-reads this page with a different capture. It is deliberately NOT given an
              `action`, so it posts to whatever address it is on and the picker works at both. */}
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
            {/* r259 — resolved through the area map above, so this record and the menu beside it point
                at the same leave type screen. OUT of the preview module until Round 5 repoints the map;
                see components/leave-config-map.tsx → leaveConfigScreenHref. */}
            <Link href={leaveConfigScreenHref('leaveTypes')} className="ml-auto text-sm underline">
              {t('backToEntitlements')}
            </Link>
          </form>

          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="bg-muted/40 text-xs uppercase text-muted-foreground">
                <tr>
                  <th className="px-3 py-2">{t('colLayer')}</th>
                  <th className="px-3 py-2">{t('colScheme')}</th>
                  <th className="px-3 py-2">{t('colLeaveType')}</th>
                  <th className="px-3 py-2">{t('colCompany')}</th>
                  <th className="px-3 py-2">{t('colGrade')}</th>
                  <th className="px-3 py-2">{t('colEmploymentType')}</th>
                  <th className="px-3 py-2">{t('colEntitlement')}</th>
                  <th className="px-3 py-2">{t('colInForce')}</th>
                  <th className="px-3 py-2">{t('colNote')}</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id} className="border-t align-top">
                    <td className="whitespace-nowrap px-3 py-2">
                      {r.layer === 'scheme' ? t('layerScheme') : t('layerPolicy')}
                    </td>
                    <td className="px-3 py-2">
                      {r.schemeName ?? dash}
                      {r.schemeCategory ? (
                        <span className="block text-xs text-muted-foreground">{r.schemeCategory}</span>
                      ) : null}
                    </td>
                    <td className="px-3 py-2">
                      {r.leaveTypeName ?? dash}
                      {r.leaveTypeCode ? (
                        <span className="block text-xs text-muted-foreground">{r.leaveTypeCode}</span>
                      ) : null}
                    </td>
                    {/* A null company on the POLICY side is the group default — a real value somebody chose,
                        not missing data. A blank cell here would read as "unknown". */}
                    <td className="px-3 py-2">
                      {r.companyName ?? (r.layer === 'policy' ? t('allCompanies') : dash)}
                    </td>
                    <td className="px-3 py-2">
                      {r.layer === 'scheme'
                        ? (r.schemeGradeGroupName ?? dash)
                        : (r.gradeName ?? t('allGrades'))}
                      {r.schemeGradeGroupMembers ? (
                        <span className="block text-xs text-muted-foreground">{r.schemeGradeGroupMembers}</span>
                      ) : null}
                    </td>
                    <td className="whitespace-nowrap px-3 py-2">{r.employmentType ?? dash}</td>
                    <td className="px-3 py-2">{r.entitlementText ?? dash}</td>
                    <td className="px-3 py-2 text-xs text-muted-foreground">
                      {r.validFromText ?? dash}
                      <span className="block">{r.validToText ?? dash}</span>
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
