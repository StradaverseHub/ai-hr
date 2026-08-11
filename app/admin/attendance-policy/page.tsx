import { getTranslations } from 'next-intl/server';
import Link from 'next/link';
import { requireAdmin } from '@/lib/authz';
import { ensureStandardRule, listAttendanceRules } from '@/core/attendance-rule';
import { Badge, Card, ErrorBanner, PageHeader, btnPrimary, btnGhost, pageWideCls } from '@/components/ui';
import { deleteAttendanceRuleAction } from './rule-actions';

/**
 * Lateness, Early Out & Overtime Settings — the tenant-wide library of attendance calculation rules.
 *
 * af7a8eb4 — this page is now the rule LIST and nothing else, at FULL window width. The company work
 * schedule, the tenant Overtime rates, the backup-shift coverage card and the registered-devices table
 * MOVED (not deleted, and no value changed) to /admin/attendance-policy/schedule, reached by the button in
 * the header. The reporter's complaint was that the list they came to read was a small strip at the top of
 * a very long page.
 *
 * Admin-only via requireAdmin(); rule writes are DB-gated by RLS.
 */
export default async function AttendancePolicyPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const s = await requireAdmin();
  const { error } = await searchParams;

  // 88e94371 — the attendance-rule library. Ensure the tenant's un-deletable Standard rule exists
  // (idempotent), then list every rule. This is the runtime complement of migration 0203.
  // 6da67ab7: the library is tenant-wide — no company column, no company filter. A rule reaches an employee
  // through the SHIFT they are assigned to, and shifts are tenant-wide too.
  const tr = await getTranslations('admin.attendanceRule');
  await ensureStandardRule(s);
  const rules = await listAttendanceRules(s);


  return (
    <div className={pageWideCls}>
      <PageHeader
        title={tr('moduleTitle')}
        description={tr('moduleDescription')}
        actions={
          <>
            {/* af7a8eb4 — the way to the relocated company work schedule + overtime rates. Labelled with
                the section's OWN existing heading string, so the button says exactly what the block it
                opens used to be called on this page. */}
            <Link href="/admin/attendance-policy/schedule" className={btnGhost}>
              {tr('scheduleSectionTitle')}
            </Link>
            <Link href="/admin/attendance-policy/rules/new" className={btnPrimary}>
              {tr('addNew')}
            </Link>
          </>
        }
      />
      <ErrorBanner message={error} />

      {/* ── 88e94371 · Rule library: the reporter's "simple list of available attendance calculation rules" ── */}
      <Card className="overflow-hidden">
        <div className="border-b border-border px-4 py-3">
          <h2 className="text-sm font-semibold text-foreground">{tr('libraryTitle')}</h2>
          <p className="mt-0.5 text-xs text-muted-foreground">{tr('libraryIntro')}</p>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[560px] text-sm">
            <thead>
              <tr className="border-b border-border text-left text-xs text-muted-foreground">
                <th className="px-4 py-2 font-medium">{tr('colName')}</th>
                <th className="px-4 py-2 font-medium">{tr('colDescription')}</th>
                <th className="px-4 py-2 font-medium">{tr('colDefault')}</th>
                <th className="px-4 py-2 font-medium">{tr('colStatus')}</th>
                <th className="px-4 py-2 text-right font-medium">{tr('colAction')}</th>
              </tr>
            </thead>
            <tbody>
              {rules.map((r) => (
                <tr key={r.id} className="border-b border-border/60">
                  <td className="px-4 py-2 font-medium text-foreground">{r.name}</td>
                  <td className="px-4 py-2 text-muted-foreground">{r.description ?? '—'}</td>
                  <td className="px-4 py-2">{r.isDefault ? <Badge>{tr('defaultBadge')}</Badge> : <span className="text-muted-foreground">—</span>}</td>
                  <td className="px-4 py-2">
                    <span className={r.status === 'active' ? 'text-emerald-600 dark:text-emerald-400' : 'text-muted-foreground'}>
                      {r.status === 'active' ? tr('statusActive') : tr('statusInactive')}
                    </span>
                  </td>
                  <td className="px-4 py-2">
                    <div className="flex items-center justify-end gap-2">
                      <Link href={`/admin/attendance-policy/rules/${r.id}`} className="text-primary hover:underline">
                        {tr('edit')}
                      </Link>
                      {!r.isDefault && (
                        <form action={deleteAttendanceRuleAction}>
                          <input type="hidden" name="ruleId" value={r.id} />
                          <button className="text-destructive hover:underline">{tr('delete')}</button>
                        </form>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}
