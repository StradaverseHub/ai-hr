import { AttendanceSettingsNavigation } from '@/components/attendance-settings-navigation';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { requireAdmin } from '@/lib/authz';
import { builtinMappingLastUsed, getClockingMapping } from '@/packs/attendance/service';
import { BUILTIN_MAPPING_ID, BUILTIN_MAPPING_NAME, CLOCKING_FIELDS, REQUIRED_CLOCKING_FIELDS } from '@/lib/clocking-file';
import { formatDmy } from '@/lib/date-display';
import { Button, PageHeader } from '@/components/ui';
import { LabelValue, LabelValueList, SectionCard, typeHelpCls, typeValueCls } from '@/components/ui/section-card';
import { layoutLabel } from '../labels';

/**
 * r424 (50ed39e1) — one mapping, read-only. The built-in AIHR Standard Template has this page too (at
 * /builtin) and no Edit: it is code, and every tenant reads today's staff_id, timestamp files through it.
 */
export default async function FileMappingViewPage({ params }: { params: Promise<{ mappingId: string }> }) {
  const s = await requireAdmin();
  const { mappingId } = await params;
  const t = await getTranslations('clockingFile');
  const back = { href: '/admin/attendance/file-mappings', label: t('form.back') };
  const pre = 'overflow-x-auto rounded-md bg-muted/50 p-3 font-mono text-xs monolith:rounded-none monolith:border-l-2 monolith:border-ink monolith:bg-transparent';

  // r427 (50ed39e1 contest) — the same facts as before, in labelled sections of label-and-value pairs.
  if (mappingId === BUILTIN_MAPPING_ID) {
    const last = await builtinMappingLastUsed(s);
    return (
      <div className="mx-auto max-w-5xl space-y-6">
        <AttendanceSettingsNavigation />
      <PageHeader back={back} title={BUILTIN_MAPPING_NAME} description={t('view.builtinIntro')} />
        <SectionCard index={1} title={t('form.secDetails')}>
          <LabelValueList columns={2}>
            <LabelValue label={t('list.colDevice')} value={t('list.anyDevice')} />
            <LabelValue label={t('view.lastUsed')} value={last ? formatDmy(last) : t('list.neverUsed')} />
          </LabelValueList>
        </SectionCard>
        <SectionCard index={2} title={t('sec.fileFormat')}>
          <LabelValueList columns={2}>
            <LabelValue label={t('list.colFileType')} value={t('fileType.csv')} />
            <LabelValue label={t('list.colLayout')} value={t('layoutName.builtin')} />
          </LabelValueList>
          <p className={`mt-4 ${typeValueCls}`}>{t('view.builtinFormat')}</p>
          <pre className={`mt-3 ${pre}`}>{`staff_id,timestamp\n001234,2026-10-01 08:15\n001234,2026-10-01 17:32`}</pre>
        </SectionCard>
        <SectionCard index={3} title={t('form.codesTitle')}>
          <p className={typeHelpCls}>{t('view.noCodes')}</p>
        </SectionCard>
      </div>
    );
  }

  if (!/^[0-9a-f-]{36}$/i.test(mappingId)) notFound();
  const m = await getClockingMapping(s, mappingId);
  if (!m) notFound();
  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <PageHeader
        back={back}
        title={m.name}
        description={m.description || undefined}
        actions={
          <Button asChild variant="outline">
            <Link href={`/admin/attendance/file-mappings/${m.id}/edit`}>{t('list.edit')}</Link>
          </Button>
        }
      />
      <SectionCard index={1} title={t('form.secDetails')}>
        <LabelValueList columns={2}>
          <LabelValue label={t('list.colDevice')} value={m.deviceName || '—'} />
          <LabelValue label={t('list.colStatus')} value={m.active ? t('status.active') : t('status.inactive')} />
          <LabelValue label={t('view.lastUsed')} value={m.lastUsedAt ? formatDmy(m.lastUsedAt) : t('list.neverUsed')} />
          <LabelValue label={t('view.updated')} value={formatDmy(m.updatedAt)} />
        </LabelValueList>
      </SectionCard>

      <SectionCard index={2} title={t('sec.fileFormat')}>
        <LabelValueList columns={2}>
          <LabelValue label={t('list.colFileType')} value={t(`fileType.${m.fileType}`)} />
          <LabelValue label={t('list.colLayout')} value={layoutLabel(t, m)} />
          <LabelValue label={t('form.hasHeader')} value={m.hasHeader ? t('form.yes') : t('form.no')} />
          <LabelValue label={t('form.encoding')} value={m.encoding} />
        </LabelValueList>
      </SectionCard>

      <SectionCard index={3} title={m.layout === 'fixed_width' ? t('form.secPositions') : t('form.secFields')}>
        <LabelValueList columns={2}>
          {CLOCKING_FIELDS.map((f) => {
            const spec = m.fields[f];
            return (
              <LabelValue
                key={f}
                label={t(`fields.${f}`)}
                required={REQUIRED_CLOCKING_FIELDS.includes(f)}
                valueClassName={spec ? undefined : 'text-muted-foreground monolith:text-mid'}
                value={
                  !spec
                    ? t('form.notMapped')
                    : 'column' in spec
                      ? t('view.columnN', { n: spec.column })
                      : t('view.position', { start: spec.start, end: spec.end })
                }
              />
            );
          })}
        </LabelValueList>
      </SectionCard>

      <SectionCard index={4} title={t('form.codesTitle')}>
        {m.fields.inOutCode ? (
          <LabelValueList columns={2}>
            {m.inOutCodes.map((c) => (
              <LabelValue key={c.code} label={<span className="font-mono normal-case tracking-normal">{c.code}</span>} value={t(`direction.${c.direction}`)} />
            ))}
          </LabelValueList>
        ) : (
          <p className={typeHelpCls}>{t('view.noCodes')}</p>
        )}
      </SectionCard>

      <SectionCard index={5} title={t('view.sample')}>
        {m.sampleLines.length ? (
          <pre className={`max-h-80 overflow-auto ${pre}`}>{m.sampleLines.join('\n')}</pre>
        ) : (
          <p className={typeHelpCls}>{t('view.noSampleKept')}</p>
        )}
      </SectionCard>
    </div>
  );
}
