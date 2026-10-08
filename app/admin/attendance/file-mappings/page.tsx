import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { requireAdmin } from '@/lib/authz';
import { builtinMappingLastUsed, listClockingMappings } from '@/packs/attendance/service';
import { BUILTIN_MAPPING_ID, BUILTIN_MAPPING_NAME } from '@/lib/clocking-file';
import { formatDmy } from '@/lib/date-display';
import { Button, ErrorBanner, PageHeader, inputCls } from '@/components/ui';
import { ConfirmSubmit } from '@/components/ui/confirm-submit';
import { SectionCard, noteCls, typeHelpCls, typeLabelCls } from '@/components/ui/section-card';
import { StackedBody, StackedHead, StackedRow, StackedTable, StackedTd, StackedTh } from '@/components/ui/stacked-table';
import { StatusWord } from '@/components/ui/status-word';
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

  const link = 'text-primary underline-offset-2 hover:underline monolith:text-ink monolith:underline';
  // r427 — Classic's pill string is unchanged; Monolith writes the status as a word.
  const pill = (on: boolean) =>
    `inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${on ? 'bg-emerald-50 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-400' : 'bg-muted text-muted-foreground'}`;
  const statusWord = (on: boolean) => (
    <StatusWord tone={on ? 'ink' : 'mid'} className={pill(on)}>
      {on ? t('status.active') : t('status.inactive')}
    </StatusWord>
  );
  const actionsCls = 'flex flex-wrap items-center justify-end gap-x-3 gap-y-1 @max-3xl:justify-start';

  return (
    <div className="mx-auto max-w-[90rem] space-y-6">
      <PageHeader
        title={t('list.title')}
        description={t('list.description')}
        actions={
          // asChild: Button is a client component, so its variant classes cannot be computed here (r424
          // render check: calling buttonVariants() from a server page throws at runtime, not at tsc).
          <Button asChild>
            <Link href="/admin/attendance/file-mappings/new">{t('list.newMapping')}</Link>
          </Button>
        }
      />
      {sp.error && <ErrorBanner message={sp.error} />}

      {/* r427 (50ed39e1 contest) — two sections: the filters, then the list. Same filters, columns and actions. */}
      <SectionCard index={1} title={t('sec.findMapping')}>
        <form method="get" className="grid gap-3 @2xl:grid-cols-[minmax(0,1fr)_12rem_12rem_auto] @2xl:items-end">
          <label className="flex min-w-0 flex-col gap-1.5">
            <span className={typeLabelCls}>{t('list.search')}</span>
            <input name="q" defaultValue={sp.q ?? ''} className={inputCls} placeholder={t('list.searchPlaceholder')} />
          </label>
          <label className="flex min-w-0 flex-col gap-1.5">
            <span className={typeLabelCls}>{t('list.fileTypeFilter')}</span>
            <select name="type" defaultValue={type} className={inputCls}>
              <option value="">{t('list.all')}</option>
              <option value="csv">{t('fileType.csv')}</option>
              <option value="txt">{t('fileType.txt')}</option>
            </select>
          </label>
          <label className="flex min-w-0 flex-col gap-1.5">
            <span className={typeLabelCls}>{t('list.statusFilter')}</span>
            <select name="status" defaultValue={status} className={inputCls}>
              <option value="">{t('list.all')}</option>
              <option value="active">{t('status.active')}</option>
              <option value="inactive">{t('status.inactive')}</option>
            </select>
          </label>
          <Button type="submit" variant="outline">
            {t('list.apply')}
          </Button>
        </form>
      </SectionCard>

      <SectionCard index={2} title={t('sec.mappings')}>
        <StackedTable label={t('sec.mappings')}>
          <StackedHead>
            <StackedTh>{t('list.colName')}</StackedTh>
            <StackedTh>{t('list.colFileType')}</StackedTh>
            <StackedTh>{t('list.colLayout')}</StackedTh>
            <StackedTh>{t('list.colDevice')}</StackedTh>
            <StackedTh>{t('list.colStatus')}</StackedTh>
            <StackedTh>{t('list.colLastUsed')}</StackedTh>
            <StackedTh className="text-right">{t('list.colActions')}</StackedTh>
          </StackedHead>
          <StackedBody>
            {rows.map((m) => (
              <StackedRow key={m.id} className={m.active ? '' : 'text-muted-foreground monolith:text-mid'}>
                <StackedTd label={t('list.colName')} role="title" className="font-medium">
                  {m.name}
                </StackedTd>
                <StackedTd label={t('list.colFileType')}>{t(`fileType.${m.fileType}`)}</StackedTd>
                <StackedTd label={t('list.colLayout')} className="text-muted-foreground monolith:text-mid">
                  {layoutLabel(t, m)}
                </StackedTd>
                <StackedTd label={t('list.colDevice')}>{m.deviceName || '—'}</StackedTd>
                <StackedTd label={t('list.colStatus')} role="aside" hideLabel>
                  {statusWord(m.active)}
                </StackedTd>
                <StackedTd label={t('list.colLastUsed')} className="tabular-nums">
                  {m.lastUsedAt ? formatDmy(m.lastUsedAt) : t('list.neverUsed')}
                </StackedTd>
                <StackedTd label={t('list.colActions')} role="full" hideLabel>
                  <div className={actionsCls}>
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
                </StackedTd>
              </StackedRow>
            ))}
            {builtinShown && (
              <StackedRow>
                <StackedTd label={t('list.colName')} role="title" className="font-medium">
                  <span className="inline-flex flex-wrap items-center gap-2">
                    {BUILTIN_MAPPING_NAME}
                    <span className="rounded border border-border px-1.5 py-0.5 text-xs font-normal monolith:rounded-none monolith:border-mid monolith:font-mono monolith:text-[10px] monolith:uppercase monolith:tracking-[0.12em] monolith:text-mid">
                      {t('list.builtin')}
                    </span>
                  </span>
                </StackedTd>
                <StackedTd label={t('list.colFileType')}>{t('fileType.csv')}</StackedTd>
                <StackedTd label={t('list.colLayout')} className="text-muted-foreground monolith:text-mid">
                  {t('layoutName.builtin')}
                </StackedTd>
                <StackedTd label={t('list.colDevice')}>{t('list.anyDevice')}</StackedTd>
                <StackedTd label={t('list.colStatus')} role="aside" hideLabel>
                  {statusWord(true)}
                </StackedTd>
                <StackedTd label={t('list.colLastUsed')} className="tabular-nums">
                  {builtinLast ? formatDmy(builtinLast) : t('list.neverUsed')}
                </StackedTd>
                <StackedTd label={t('list.colActions')} role="full" hideLabel>
                  <div className={actionsCls}>
                    <Link className={link} href={`/admin/attendance/file-mappings/${BUILTIN_MAPPING_ID}`}>
                      {t('list.view')}
                    </Link>
                  </div>
                </StackedTd>
              </StackedRow>
            )}
            {rows.length === 0 && !builtinShown && (
              <StackedRow>
                <StackedTd label={t('list.colName')} role="full" hideLabel colSpan={7} className="px-4 py-8 text-center text-muted-foreground">
                  {t('list.empty')}
                </StackedTd>
              </StackedRow>
            )}
          </StackedBody>
        </StackedTable>
        <div className={`mt-3 flex flex-wrap items-start justify-between gap-x-6 gap-y-2 ${typeHelpCls}`}>
          <span>{t('list.summary', { count: total, active })}</span>
          <span>{t('list.deleteNote')}</span>
        </div>
      </SectionCard>

      <p className={noteCls}>{t.rich('list.inactiveNote', { b: (c) => <strong>{c}</strong> })}</p>
    </div>
  );
}
