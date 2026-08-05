import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { requireAdmin } from '@/lib/authz';
import { listEntitlementArchiveCaptures, listEntitlementResetArchive } from '@/packs/leave/service';
import { Card, PageHeader, btnPrimary, inputCls } from '@/components/ui';

/**
 * 6e9a126e — THE ENTITLEMENT CONFIGURATION RECORD (read-only).
 *
 * The approved plan promises the reporter: "That record becomes a read-only listing inside your admin
 * screens that you can open and download, so you read the old figures off it while you retype them rather
 * than working from memory. It feeds nothing and changes no number." THIS SCREEN IS THAT SENTENCE.
 *
 * The plan's own build notes call it out as the gap in the earlier revision, which specified a table plus
 * a RAISE NOTICE — and a notice reaches the deploy log and nobody else. The precedent it cited proves the
 * point: `leave_shared_group_reset_archive` (migration 0342) is documented as never read and never joined,
 * and a test actively asserts no core file reads it. Same table shape, opposite posture.
 *
 * It ships in RELEASE ONE, two releases before anything can be cleared, on purpose. A record that arrives
 * with the deletion has never been read by anyone before it had to be trusted.
 *
 * READ-ONLY BY CONSTRUCTION: no form, no action, no mutation. It is deliberately not wired into the
 * sidebar either — it is reached from the Entitlements screen, because it is a reference document for a
 * migration in progress rather than a place anybody works.
 */
export default async function EntitlementArchivePage({
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
      <PageHeader title={t('pageTitle')} description={t('pageDescription')} />

      <Card>
        <div className="space-y-3 p-4 text-sm">
          <p className="text-muted-foreground">{t('intro')}</p>
          {/* The plan states this in the business half and it is the sentence people most need to read
              twice: the record is a listing to retype from, not an undo button. */}
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
            <Link href="/admin/leave/entitlements" className="ml-auto text-sm underline">
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
