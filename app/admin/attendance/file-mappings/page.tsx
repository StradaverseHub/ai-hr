import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { requireAdmin } from '@/lib/authz';
import { builtinMappingLastUsed, listClockingMappings } from '@/packs/attendance/service';
import { BUILTIN_MAPPING_ID, BUILTIN_MAPPING_NAME } from '@/lib/clocking-file';
import { formatDmy } from '@/lib/date-display';
import { Card, ErrorBanner, PageHeader, buttonVariants, inputCls } from '@/components/ui';
import { ConfirmSubmit } from '@/components/ui/confirm-submit';
import { deleteClockingMappingAction, duplicateClockingMappingAction, setClockingMappingActiveAction } from './actions';
import { layoutLabel } from './labels';

/**
 * r424 (50ed39e1) — Attendance › File Structure Mapping: one mapping per clocking device or file layout.
 * The built-in "AIHR Standard Template" (today's staff_id, timestamp layout) is listed first-class, view
 * only — it is code, not a row. Delete is offered only for a mapping no import has used; the service
 * refuses it anyway (and the log's FK is RESTRICT).
 */
export default async function FileMappingsPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; type?: string; status?: string; error?: string }>;
}) {
  const s = await requireAdmin();
  const t = await getTranslations('clockingFile');
  const sp = await searchParams;
  const [mappings, builtinLast] = await Promise.all([listClockingMappings(s), builtinMappingLastUsed(s)]);

  const q = sp.q?.trim().toLowerCase() || '';
  const type = sp.type === 'csv' || sp.type === 'txt' ? sp.type : '';
  const status = sp.status === 'active' || sp.status === 'inactive' ? sp.status : '';
  const rows = mappings.filter(
    (m) =>
      (!q || m.name.toLowerCase().includes(q) || m.deviceName.toLowerCase().includes(q)) &&
      (!type || m.fileType === type) &&
      (!status || (status === 'active' ? m.active : !m.active)),
  );
  const builtinShown =
    (!q || BUILTIN_MAPPING_NAME.toLowerCase().includes(q)) && (!type || type === 'csv') && status !== 'inactive';
  const total = mappings.length + 1;
  const active = mappings.filter((m) => m.active).length + 1;

  const th = 'px-3 py-2 font-medium';
  const td = 'px-3 py-2.5';
  const link = 'text-primary underline-offset-2 hover:underline';
  const pill = (on: boolean) =>
    `inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${on ? 'bg-emerald-50 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-400' : 'bg-muted text-muted-foreground'}`;

  return (
    <div className="mx-auto max-w-[90rem] space-y-6">
      <PageHeader
        title={t('list.title')}
        description={t('list.description')}
        actions={
          <Link href="/admin/attendance/file-mappings/new" className={buttonVariants()}>
            {t('list.newMapping')}
          </Link>
        }
      />
      {sp.error && <ErrorBanner message={sp.error} />}

      <form method="get" className="grid gap-3 sm:grid-cols-[1fr_12rem_12rem_auto] sm:items-end">
        <label className="flex flex-col gap-1 text-xs text-muted-foreground">
          {t('list.search')}
          <input name="q" defaultValue={sp.q ?? ''} className={inputCls} placeholder={t('list.searchPlaceholder')} />
        </label>
        <label className="flex flex-col gap-1 text-xs text-muted-foreground">
          {t('list.fileTypeFilter')}
          <select name="type" defaultValue={type} className={inputCls}>
            <option value="">{t('list.all')}</option>
            <option value="csv">{t('fileType.csv')}</option>
            <option value="txt">{t('fileType.txt')}</option>
          </select>
        </label>
        <label className="flex flex-col gap-1 text-xs text-muted-foreground">
          {t('list.statusFilter')}
          <select name="status" defaultValue={status} className={inputCls}>
            <option value="">{t('list.all')}</option>
            <option value="active">{t('status.active')}</option>
            <option value="inactive">{t('status.inactive')}</option>
          </select>
        </label>
        <button type="submit" className={buttonVariants({ variant: 'outline' })}>
          {t('list.apply')}
        </button>
      </form>

      <Card className="overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-muted/50 text-left text-xs uppercase tracking-wide text-muted-foreground">
              <tr>
                <th className={th}>{t('list.colName')}</th>
                <th className={th}>{t('list.colFileType')}</th>
                <th className={th}>{t('list.colLayout')}</th>
                <th className={th}>{t('list.colDevice')}</th>
                <th className={th}>{t('list.colStatus')}</th>
                <th className={th}>{t('list.colLastUsed')}</th>
                <th className={`${th} text-right`}>{t('list.colActions')}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {rows.map((m) => (
                <tr key={m.id} className={m.active ? '' : 'text-muted-foreground'}>
                  <td className={`${td} font-medium`}>{m.name}</td>
                  <td className={td}>{t(`fileType.${m.fileType}`)}</td>
                  <td className={`${td} text-muted-foreground`}>{layoutLabel(t, m)}</td>
                  <td className={td}>{m.deviceName || '—'}</td>
                  <td className={td}>
                    <span className={pill(m.active)}>{m.active ? t('status.active') : t('status.inactive')}</span>
                  </td>
                  <td className={`${td} tabular-nums`}>{m.lastUsedAt ? formatDmy(m.lastUsedAt) : t('list.neverUsed')}</td>
                  <td className={td}>
                    <div className="flex flex-wrap items-center justify-end gap-x-3 gap-y-1">
                      <Link className={link} href={`/admin/attendance/file-mappings/${m.id}`}>
                        {t('list.view')}
                      </Link>
                      <Link className={link} href={`/admin/attendance/file-mappings/${m.id}/edit`}>
                        {t('list.edit')}
                      </Link>
                      <form action={duplicateClockingMappingAction}>
                        <input type="hidden" name="mappingId" value={m.id} />
                        <button type="submit" className={link}>
                          {t('list.duplicate')}
                        </button>
                      </form>
                      <form action={setClockingMappingActiveAction}>
                        <input type="hidden" name="mappingId" value={m.id} />
                        <input type="hidden" name="active" value={m.active ? 'false' : 'true'} />
                        <button type="submit" className={link}>
                          {m.active ? t('list.deactivate') : t('list.activate')}
                        </button>
                      </form>
                      {!m.lastUsedAt && (
                        <form action={deleteClockingMappingAction}>
                          <input type="hidden" name="mappingId" value={m.id} />
                          <ConfirmSubmit
                            variant="ghost"
                            size="sm"
                            className="h-auto px-0 py-0 text-destructive"
                            description={t('list.deleteConfirm', { name: m.name })}
                            confirmLabel={t('list.delete')}
                          >
                            {t('list.delete')}
                          </ConfirmSubmit>
                        </form>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
              {builtinShown && (
                <tr>
                  <td className={`${td} font-medium`}>
                    <span className="inline-flex flex-wrap items-center gap-2">
                      {BUILTIN_MAPPING_NAME}
                      <span className="rounded border border-border px-1.5 py-0.5 text-xs font-normal">{t('list.builtin')}</span>
                    </span>
                  </td>
                  <td className={td}>{t('fileType.csv')}</td>
                  <td className={`${td} text-muted-foreground`}>{t('layoutName.builtin')}</td>
                  <td className={td}>{t('list.anyDevice')}</td>
                  <td className={td}>
                    <span className={pill(true)}>{t('status.active')}</span>
                  </td>
                  <td className={`${td} tabular-nums`}>{builtinLast ? formatDmy(builtinLast) : t('list.neverUsed')}</td>
                  <td className={`${td} text-right`}>
                    <Link className={link} href={`/admin/attendance/file-mappings/${BUILTIN_MAPPING_ID}`}>
                      {t('list.view')}
                    </Link>
                  </td>
                </tr>
              )}
              {rows.length === 0 && !builtinShown && (
                <tr>
                  <td colSpan={7} className="px-4 py-8 text-center text-muted-foreground">
                    {t('list.empty')}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </Card>

      <div className="flex flex-wrap items-start justify-between gap-2 text-sm text-muted-foreground">
        <span>{t('list.summary', { count: total, active })}</span>
        <span>{t('list.deleteNote')}</span>
      </div>
      <p className="border-l-2 border-primary bg-muted/40 px-4 py-3 text-sm">
        {t.rich('list.inactiveNote', { b: (c) => <strong>{c}</strong> })}
      </p>
    </div>
  );
}
