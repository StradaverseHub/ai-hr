import { getTranslations } from 'next-intl/server';

import type { SessionContext } from '@/db/client';
import { listEntitlementArchiveCaptures, listEntitlementResetArchive } from '@/packs/leave/service';
import { Card, btnPrimary, inputCls } from '@/components/ui';

/**
 * 7f69bd71 — THE CONFIGURATION RECORD, as the first sub-tab of the Reset records sub-screen
 * (`/admin/leave-config/records?record=configuration`).
 *
 * THIS IS THE BODY OF `app/admin/leave-config/records/entitlement/page.tsx` MOVED, NOT REWRITTEN: the
 * intro card, the "Record taken" picker with Show and Download as CSV, and the nine-column listing with
 * its four layer labels — exactly what the Entitlements tab showed until this round. The page that owned
 * it is a redirect stub now; the reporter's complaint was where the record SAT, not what it showed.
 *
 * WHAT IT IS (6e9a126e, unchanged): the approved plan promised the reporter "a read-only listing inside
 * your admin screens that you can open and download, so you read the old figures off it while you retype
 * them rather than working from memory. It feeds nothing and changes no number." The 492da418 plan that
 * ran on 2026-09-11 said the same of the record it took before clearing every entitlement table and rule.
 *
 * READ-ONLY BY CONSTRUCTION: no form that mutates, no server action, no import of one. The only `<form>`
 * is a GET that re-reads the sub-screen with a different `?capture=`. It carries a hidden `record` field
 * so Show keeps the sub-tab it was pressed on; it is deliberately NOT given an `action`, so it posts to
 * whatever address it is on.
 *
 * ⚠️ THE CSV LINK STILL POINTS AT THE OLD `/export` ROUTE HANDLER, AND IT STAYS THERE. The handler is
 * NOT a page: it has no screen column, it was never in lib/permissions.ts, and nothing about this move
 * requires it to move. Re-addressing it would break every download link an administrator has saved and
 * would buy nothing — so `app/admin/leave/entitlements/archive/export/route.ts` is left exactly where it
 * is, and this component links to it unchanged.
 *
 * SERVER COMPONENT, and it must stay one: plain markup, one `getTranslations`, only serialisable props
 * (test/server-client-boundary.test.ts). F45 IS THE WHOLE OF THIS COMPONENT and it is carried complete.
 */
export async function ResetRecordConfiguration({ s, capture }: { s: SessionContext; capture?: string }) {
  const t = await getTranslations('admin.entitlementArchive');

  const captures = await listEntitlementArchiveCaptures(s);
  // An unknown ?capture is ignored rather than rendering an empty table for a tag that does not exist.
  const chosen = captures.find((c) => c.captureTag === capture)?.captureTag ?? captures[0]?.captureTag;
  const rows = await listEntitlementResetArchive(s, { captureTag: chosen });

  const dash = '—';
  // fe9c73bc — a capture written by the entitlement-configuration reset holds template / rule rows, whose
  // first column is a table or rule NAME, not a benefit scheme. The header follows the rows on show; an
  // older scheme / policy capture keeps reading "Benefit scheme" exactly as before.
  const holdsTemplateOrRule = rows.some((r) => r.layer === 'template' || r.layer === 'rule');
  const csvHref = chosen
    ? `/admin/leave/entitlements/archive/export?capture=${encodeURIComponent(chosen)}`
    : '/admin/leave/entitlements/archive/export';

  return (
    <div className="space-y-6">
      <Card>
        <div className="space-y-3 p-4 text-sm">
          <p className="font-medium text-foreground">{t('pageDescription')}</p>
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
          {/* A GET form — it re-reads the sub-screen with a different capture. No `action`, so it posts to
              whatever address it is on; the hidden `record` keeps Show on THIS sub-tab. */}
          <form className="flex flex-wrap items-end gap-3 border-b p-4">
            <input type="hidden" name="record" value="configuration" />
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

          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="bg-muted/40 text-xs uppercase text-muted-foreground">
                <tr>
                  <th className="px-3 py-2">{t('colLayer')}</th>
                  <th className="px-3 py-2">{holdsTemplateOrRule ? t('colTemplateOrRule') : t('colScheme')}</th>
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
                    {/* fe9c73bc — two more layers, written by scripts/reset-entitlement-configuration.ts:
                        'template' (an entitlement table) and 'rule' (an eligibility rule). The first two
                        render exactly as before; a layer this record does not know falls through to the
                        policy label, as it always did. */}
                    <td className="whitespace-nowrap px-3 py-2">
                      {r.layer === 'scheme'
                        ? t('layerScheme')
                        : r.layer === 'template'
                          ? t('layerTemplate')
                          : r.layer === 'rule'
                            ? t('layerRule')
                            : t('layerPolicy')}
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
                    {/* "All grades" is a POLICY fact (a null grade there meant every grade). A template or
                        rule row carries its scope in the Entitlement column instead, so it shows a dash. */}
                    <td className="px-3 py-2">
                      {r.layer === 'policy'
                        ? (r.gradeName ?? t('allGrades'))
                        : (r.schemeGradeGroupName ?? dash)}
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
