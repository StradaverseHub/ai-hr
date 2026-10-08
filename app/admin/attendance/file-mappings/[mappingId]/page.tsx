import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { requireAdmin } from '@/lib/authz';
import { builtinMappingLastUsed, getClockingMapping } from '@/packs/attendance/service';
import { BUILTIN_MAPPING_ID, BUILTIN_MAPPING_NAME, CLOCKING_FIELDS, REQUIRED_CLOCKING_FIELDS } from '@/lib/clocking-file';
import { formatDmy } from '@/lib/date-display';
import { Button, Card, PageHeader } from '@/components/ui';
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
  const dl = 'grid gap-x-6 gap-y-3 text-sm sm:grid-cols-2 lg:grid-cols-4';
  const dt = 'text-xs text-muted-foreground';

  if (mappingId === BUILTIN_MAPPING_ID) {
    const last = await builtinMappingLastUsed(s);
    return (
      <div className="mx-auto max-w-5xl space-y-6">
        <PageHeader back={back} title={BUILTIN_MAPPING_NAME} description={t('view.builtinIntro')} />
        <Card className="space-y-4 p-5">
          <dl className={dl}>
            <div>
              <dt className={dt}>{t('list.colFileType')}</dt>
              <dd>{t('fileType.csv')}</dd>
            </div>
            <div>
              <dt className={dt}>{t('list.colLayout')}</dt>
              <dd>{t('layoutName.builtin')}</dd>
            </div>
            <div>
              <dt className={dt}>{t('list.colDevice')}</dt>
              <dd>{t('list.anyDevice')}</dd>
            </div>
            <div>
              <dt className={dt}>{t('view.lastUsed')}</dt>
              <dd>{last ? formatDmy(last) : t('list.neverUsed')}</dd>
            </div>
          </dl>
          <p className="text-sm">{t('view.builtinFormat')}</p>
          <pre className="overflow-x-auto rounded-md bg-muted/50 p-3 font-mono text-xs">{`staff_id,timestamp\n001234,2026-10-01 08:15\n001234,2026-10-01 17:32`}</pre>
          <p className="text-sm text-muted-foreground">{t('view.noCodes')}</p>
        </Card>
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
      <Card className="space-y-5 p-5">
        <dl className={dl}>
          <div>
            <dt className={dt}>{t('list.colFileType')}</dt>
            <dd>{t(`fileType.${m.fileType}`)}</dd>
          </div>
          <div>
            <dt className={dt}>{t('list.colLayout')}</dt>
            <dd>{layoutLabel(t, m)}</dd>
          </div>
          <div>
            <dt className={dt}>{t('list.colDevice')}</dt>
            <dd>{m.deviceName || '—'}</dd>
          </div>
          <div>
            <dt className={dt}>{t('list.colStatus')}</dt>
            <dd>{m.active ? t('status.active') : t('status.inactive')}</dd>
          </div>
          <div>
            <dt className={dt}>{t('form.hasHeader')}</dt>
            <dd>{m.hasHeader ? t('form.yes') : t('form.no')}</dd>
          </div>
          <div>
            <dt className={dt}>{t('form.encoding')}</dt>
            <dd>{m.encoding}</dd>
          </div>
          <div>
            <dt className={dt}>{t('view.lastUsed')}</dt>
            <dd>{m.lastUsedAt ? formatDmy(m.lastUsedAt) : t('list.neverUsed')}</dd>
          </div>
          <div>
            <dt className={dt}>{t('view.updated')}</dt>
            <dd>{formatDmy(m.updatedAt)}</dd>
          </div>
        </dl>

        <div>
          <h2 className="mb-2 text-sm font-semibold">{t('view.fields')}</h2>
          <table className="w-full max-w-xl text-sm">
            <tbody className="divide-y divide-border">
              {CLOCKING_FIELDS.map((f) => {
                const spec = m.fields[f];
                return (
                  <tr key={f}>
                    <td className="py-1.5 pr-4 font-medium">
                      {t(`fields.${f}`)}
                      {REQUIRED_CLOCKING_FIELDS.includes(f) && <span className="ml-0.5 text-destructive">*</span>}
                    </td>
                    <td className="py-1.5 text-muted-foreground">
                      {!spec
                        ? t('form.notMapped')
                        : 'column' in spec
                          ? t('view.columnN', { n: spec.column })
                          : t('view.position', { start: spec.start, end: spec.end })}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        {m.fields.inOutCode ? (
          <div>
            <h2 className="mb-2 text-sm font-semibold">{t('form.codesTitle')}</h2>
            <ul className="space-y-1 text-sm">
              {m.inOutCodes.map((c) => (
                <li key={c.code}>
                  <code className="rounded bg-muted px-1.5 py-0.5">{c.code}</code> → {t(`direction.${c.direction}`)}
                </li>
              ))}
            </ul>
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">{t('view.noCodes')}</p>
        )}

        <div>
          <h2 className="mb-2 text-sm font-semibold">{t('view.sample')}</h2>
          {m.sampleLines.length ? (
            <pre className="max-h-80 overflow-auto rounded-md bg-muted/50 p-3 font-mono text-xs">{m.sampleLines.join('\n')}</pre>
          ) : (
            <p className="text-sm text-muted-foreground">{t('view.noSampleKept')}</p>
          )}
        </div>
      </Card>
    </div>
  );
}
