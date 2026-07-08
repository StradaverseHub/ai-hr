'use client';

/**
 * Custom Report Builder — the three-panel drag-and-drop designer (ADR-0074, c440b365).
 *   Left   — searchable, grouped Available Fields (drag onto the canvas, or click Add).
 *   Center — the Report Design Canvas: the ordered chosen columns (drag to reorder, or up/down/remove)
 *            + a live preview table.
 *   Right  — Report Properties (name, dataset, orientation, sort, group, filters, summary totals, share)
 *            + the AI Report Designer (natural language → a validated spec, human-reviewed before save).
 *
 * All mutating operations are server actions (saveReportAction) invoked via <form> or imported directly;
 * preview + AI drafting are server actions returning data. Exports POST the current spec to the export
 * route and download the blob. No employee data ever leaves the tenant via the AI path — only the field
 * catalogue + the redacted request (enforced server-side in core/report-ai.ts).
 */
import { useMemo, useState, useTransition } from 'react';
import { previewReport, draftReport, saveReportAction } from './actions';
import type { CustomReportSpec } from '@/db/schema';
import type { ReportData } from '@/lib/report-export';

type FieldType = 'text' | 'date' | 'number' | 'currency' | 'status';
type Field = { id: string; label: string; type: FieldType; group: string };
type FilterDef = { id: string; label: string; kind: 'text' | 'month' | 'year' };
type DatasetView = {
  id: string;
  category: string;
  label: string;
  fields: Field[];
  filters: FilterDef[];
  defaultColumns: string[];
};

type Labels = Record<string, string>;

const isNumericType = (t: FieldType) => t === 'number' || t === 'currency';

export function ReportBuilder({
  reportId,
  name: initialName,
  shared: initialShared,
  dataset,
  datasets,
  initialSpec,
  aiEnabled,
  error,
  toast,
  labels,
}: {
  reportId: string | null;
  name: string;
  shared: boolean;
  dataset: DatasetView;
  datasets: DatasetView[];
  initialSpec: CustomReportSpec;
  aiEnabled: boolean;
  error?: string;
  toast?: string;
  labels: Labels;
}) {
  const [name, setName] = useState(initialName);
  const [shared, setShared] = useState(initialShared);
  const [activeDataset, setActiveDataset] = useState<DatasetView>(dataset);
  const [columns, setColumns] = useState<string[]>(initialSpec.columns ?? []);
  const [sort, setSort] = useState<CustomReportSpec['sort']>(initialSpec.sort ?? null);
  const [groupBy, setGroupBy] = useState<string | null>(initialSpec.groupBy ?? null);
  const [filters, setFilters] = useState<Record<string, string | number | null>>(initialSpec.filters ?? {});
  const [orientation, setOrientation] = useState<'portrait' | 'landscape'>(initialSpec.layout?.orientation ?? 'landscape');
  const [summary, setSummary] = useState<string[]>(initialSpec.layout?.summary ?? []);
  const [search, setSearch] = useState('');
  const [preview, setPreview] = useState<ReportData | null>(null);
  const [aiText, setAiText] = useState('');
  const [aiMsg, setAiMsg] = useState<string | null>(null);
  const [dragField, setDragField] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const fieldById = useMemo(() => new Map(activeDataset.fields.map((f) => [f.id, f])), [activeDataset]);
  const selected = new Set(columns);
  const available = activeDataset.fields.filter(
    (f) => !selected.has(f.id) && f.label.toLowerCase().includes(search.toLowerCase()),
  );
  const groups = useMemo(() => {
    const m = new Map<string, Field[]>();
    for (const f of available) {
      const g = m.get(f.group) ?? [];
      g.push(f);
      m.set(f.group, g);
    }
    return [...m.entries()];
  }, [available]);

  const buildSpec = (): CustomReportSpec => ({
    datasetId: activeDataset.id,
    columns,
    sort,
    groupBy,
    filters,
    layout: { orientation, summary, title: name || activeDataset.label },
  });

  const addColumn = (id: string) => setColumns((c) => (c.includes(id) ? c : [...c, id]));
  const removeColumn = (id: string) =>
    setColumns((c) => c.filter((x) => x !== id));
  const move = (id: string, dir: -1 | 1) =>
    setColumns((c) => {
      const i = c.indexOf(id);
      const j = i + dir;
      if (i < 0 || j < 0 || j >= c.length) return c;
      const next = [...c];
      [next[i], next[j]] = [next[j], next[i]];
      return next;
    });
  const reorderOnto = (target: string) =>
    setColumns((c) => {
      if (!dragField || dragField === target) return c;
      const without = c.filter((x) => x !== dragField);
      const idx = without.indexOf(target);
      without.splice(idx, 0, dragField);
      return without;
    });

  const switchDataset = (id: string) => {
    const ds = datasets.find((d) => d.id === id);
    if (!ds) return;
    setActiveDataset(ds);
    setColumns(ds.defaultColumns);
    setSort(null);
    setGroupBy(null);
    setFilters({});
    setSummary([]);
    setPreview(null);
  };

  const runPreview = () => {
    startTransition(async () => {
      const res = await previewReport(buildSpec());
      if (res.ok && res.data) {
        setPreview(res.data);
        setAiMsg(null);
      } else {
        setPreview(null);
      }
    });
  };

  const runAi = () => {
    if (!aiText.trim()) return;
    startTransition(async () => {
      const res = await draftReport(activeDataset.id, aiText.trim());
      if (res.ok && res.spec) {
        setColumns(res.spec.columns);
        setSort(res.spec.sort ?? null);
        setGroupBy(res.spec.groupBy ?? null);
        setSummary(res.spec.layout?.summary ?? []);
        if (res.spec.layout?.orientation) setOrientation(res.spec.layout.orientation);
        setAiMsg(`${labels.aiApplied}${res.explanation ? ` — ${res.explanation}` : ''}`);
      } else if (res.error === 'not_configured') {
        setAiMsg(labels.aiNotConfigured);
      } else {
        setAiMsg(labels.aiInvalid);
      }
    });
  };

  const exportAs = async (fmt: string) => {
    const resp = await fetch('/reports/export', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ spec: buildSpec(), format: fmt }),
    });
    if (!resp.ok) return;
    const blob = await resp.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${activeDataset.id}.${fmt === 'xlsx' ? 'xls' : fmt === 'docx' ? 'doc' : fmt}`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const inputCls =
    'w-full rounded-lg border border-border bg-background px-2.5 py-1.5 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-primary/40';
  const numericSelectedFields = columns.map((c) => fieldById.get(c)).filter((f): f is Field => !!f && isNumericType(f.type));

  return (
    <div className="space-y-4">
      {error && (
        <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-2 text-sm text-red-700 dark:border-red-500/20 dark:bg-red-500/10 dark:text-red-400">
          {error}
        </div>
      )}
      {toast && (
        <div className="rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-2 text-sm text-emerald-700 dark:border-emerald-500/20 dark:bg-emerald-500/10 dark:text-emerald-400">
          {toast}
        </div>
      )}

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.6fr)_minmax(0,1fr)]">
        {/* LEFT — available fields */}
        <section className="rounded-2xl border border-border bg-card p-4">
          <h3 className="mb-2 text-sm font-semibold">{labels.availableFields}</h3>
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={labels.searchFields}
            className={`${inputCls} mb-3`}
          />
          <div className="max-h-[28rem] space-y-3 overflow-y-auto">
            {groups.map(([group, fields]) => (
              <div key={group}>
                <div className="mb-1 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground/80">{group}</div>
                <ul className="space-y-1">
                  {fields.map((f) => (
                    <li
                      key={f.id}
                      draggable
                      onDragStart={() => setDragField(f.id)}
                      onDragEnd={() => setDragField(null)}
                      className="flex cursor-grab items-center justify-between rounded-lg border border-border bg-background px-2.5 py-1.5 text-sm active:cursor-grabbing"
                    >
                      <span className="truncate">{f.label}</span>
                      <button
                        type="button"
                        onClick={() => addColumn(f.id)}
                        className="ml-2 shrink-0 rounded bg-primary/10 px-1.5 text-xs font-medium text-primary hover:bg-primary/20"
                        aria-label={labels.add}
                      >
                        +
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </section>

        {/* CENTER — design canvas + preview */}
        <section
          className="rounded-2xl border border-border bg-card p-4"
          onDragOver={(e) => e.preventDefault()}
          onDrop={() => {
            if (dragField) addColumn(dragField);
            setDragField(null);
          }}
        >
          <div className="mb-2 flex items-center justify-between">
            <h3 className="text-sm font-semibold">{labels.selectedColumns}</h3>
            <span className="text-xs text-muted-foreground">{labels.dragHint}</span>
          </div>
          {columns.length === 0 ? (
            <p className="rounded-lg border border-dashed border-border px-3 py-6 text-center text-sm text-muted-foreground">
              {labels.noColumns}
            </p>
          ) : (
            <ul className="space-y-1">
              {columns.map((id) => {
                const f = fieldById.get(id);
                return (
                  <li
                    key={id}
                    draggable
                    onDragStart={() => setDragField(id)}
                    onDragEnd={() => setDragField(null)}
                    onDragOver={(e) => e.preventDefault()}
                    onDrop={(e) => {
                      e.stopPropagation();
                      reorderOnto(id);
                      setDragField(null);
                    }}
                    className="flex items-center justify-between gap-2 rounded-lg border border-border bg-background px-2.5 py-1.5 text-sm"
                  >
                    <span className="flex min-w-0 items-center gap-2">
                      <span aria-hidden className="cursor-grab text-muted-foreground">⋮⋮</span>
                      <span className="truncate">{f?.label ?? id}</span>
                    </span>
                    <span className="flex shrink-0 items-center gap-1 text-muted-foreground">
                      <button type="button" onClick={() => move(id, -1)} aria-label={labels.moveUp} className="rounded px-1 hover:bg-accent/60">↑</button>
                      <button type="button" onClick={() => move(id, 1)} aria-label={labels.moveDown} className="rounded px-1 hover:bg-accent/60">↓</button>
                      <button type="button" onClick={() => removeColumn(id)} aria-label={labels.remove} className="rounded px-1 text-red-600 hover:bg-accent/60 dark:text-red-400">✕</button>
                    </span>
                  </li>
                );
              })}
            </ul>
          )}

          {/* Live preview */}
          <div className="mt-4">
            <div className="mb-2 flex items-center justify-between">
              <h4 className="text-sm font-semibold">{labels.preview}</h4>
              <button
                type="button"
                onClick={runPreview}
                disabled={pending || columns.length === 0}
                className="rounded-lg border border-border px-2.5 py-1 text-xs font-medium hover:bg-accent/60 disabled:opacity-50"
              >
                {labels.refreshPreview}
              </button>
            </div>
            {preview ? (
              <div className="overflow-x-auto rounded-lg border border-border">
                <table className="w-full text-left text-xs">
                  <thead className="bg-muted/50">
                    <tr>
                      {preview.columns.map((c) => (
                        <th key={c} className="whitespace-nowrap px-2 py-1.5 font-semibold">{c}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {preview.rows.map((r, i) => (
                      <tr key={i} className="border-t border-border">
                        {r.map((cell, j) => (
                          <td key={j} className="whitespace-nowrap px-2 py-1">{cell == null ? '' : String(cell)}</td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <p className="rounded-lg border border-dashed border-border px-3 py-4 text-center text-xs text-muted-foreground">{labels.noPreview}</p>
            )}
            <p className="mt-1 text-[11px] text-muted-foreground">{labels.previewNote}</p>
          </div>
        </section>

        {/* RIGHT — properties + AI */}
        <section className="space-y-4">
          <div className="rounded-2xl border border-border bg-card p-4">
            <h3 className="mb-3 text-sm font-semibold">{labels.properties}</h3>
            <div className="space-y-3">
              <label className="block text-xs font-medium text-muted-foreground">
                {labels.reportName}
                <input value={name} onChange={(e) => setName(e.target.value)} className={`${inputCls} mt-1`} />
              </label>
              {datasets.length > 1 && (
                <label className="block text-xs font-medium text-muted-foreground">
                  {labels.dataset}
                  <select value={activeDataset.id} onChange={(e) => switchDataset(e.target.value)} className={`${inputCls} mt-1`}>
                    {datasets.map((d) => (
                      <option key={d.id} value={d.id}>{d.label}</option>
                    ))}
                  </select>
                </label>
              )}
              <label className="block text-xs font-medium text-muted-foreground">
                {labels.orientation}
                <select value={orientation} onChange={(e) => setOrientation(e.target.value as 'portrait' | 'landscape')} className={`${inputCls} mt-1`}>
                  <option value="portrait">{labels.portrait}</option>
                  <option value="landscape">{labels.landscape}</option>
                </select>
              </label>
              <label className="block text-xs font-medium text-muted-foreground">
                {labels.sortBy}
                <div className="mt-1 flex gap-2">
                  <select
                    value={sort?.field ?? ''}
                    onChange={(e) => setSort(e.target.value ? { field: e.target.value, dir: sort?.dir ?? 'asc' } : null)}
                    className={inputCls}
                  >
                    <option value="">{labels.none}</option>
                    {columns.map((c) => (
                      <option key={c} value={c}>{fieldById.get(c)?.label ?? c}</option>
                    ))}
                  </select>
                  {sort && (
                    <select value={sort.dir} onChange={(e) => setSort({ field: sort.field, dir: e.target.value as 'asc' | 'desc' })} className={inputCls}>
                      <option value="asc">{labels.ascending}</option>
                      <option value="desc">{labels.descending}</option>
                    </select>
                  )}
                </div>
              </label>
              <label className="block text-xs font-medium text-muted-foreground">
                {labels.groupBy}
                <select value={groupBy ?? ''} onChange={(e) => setGroupBy(e.target.value || null)} className={`${inputCls} mt-1`}>
                  <option value="">{labels.none}</option>
                  {columns.map((c) => (
                    <option key={c} value={c}>{fieldById.get(c)?.label ?? c}</option>
                  ))}
                </select>
              </label>

              {activeDataset.filters.length > 0 && (
                <div>
                  <div className="mb-1 text-xs font-medium text-muted-foreground">{labels.filters}</div>
                  <div className="space-y-2">
                    {activeDataset.filters.map((f) => (
                      <label key={f.id} className="block text-[11px] text-muted-foreground">
                        {f.label}
                        <input
                          type={f.kind === 'month' ? 'month' : f.kind === 'year' ? 'number' : 'text'}
                          value={(filters[f.id] as string | number | undefined) ?? ''}
                          onChange={(e) => setFilters((prev) => ({ ...prev, [f.id]: e.target.value || null }))}
                          className={`${inputCls} mt-0.5`}
                        />
                      </label>
                    ))}
                  </div>
                </div>
              )}

              {numericSelectedFields.length > 0 && (
                <div>
                  <div className="mb-1 text-xs font-medium text-muted-foreground">{labels.summaryRow}</div>
                  <div className="space-y-1">
                    {numericSelectedFields.map((f) => (
                      <label key={f.id} className="flex items-center gap-2 text-xs">
                        <input
                          type="checkbox"
                          checked={summary.includes(f.id)}
                          onChange={(e) =>
                            setSummary((prev) => (e.target.checked ? [...prev, f.id] : prev.filter((x) => x !== f.id)))
                          }
                        />
                        {f.label}
                      </label>
                    ))}
                  </div>
                </div>
              )}

              <label className="flex items-center gap-2 text-xs">
                <input type="checkbox" checked={shared} onChange={(e) => setShared(e.target.checked)} />
                {labels.shareToggle}
              </label>
            </div>
          </div>

          {/* AI Report Designer */}
          <div className="rounded-2xl border border-border bg-card p-4">
            <h3 className="mb-1 flex items-center gap-1.5 text-sm font-semibold">✨ {labels.aiTitle}</h3>
            <p className="mb-2 text-[11px] text-muted-foreground">{labels.aiDescribe}</p>
            <textarea
              value={aiText}
              onChange={(e) => setAiText(e.target.value)}
              placeholder={labels.aiPlaceholder}
              rows={3}
              disabled={!aiEnabled}
              className={`${inputCls} resize-none disabled:opacity-60`}
            />
            <button
              type="button"
              onClick={runAi}
              disabled={!aiEnabled || pending || !aiText.trim()}
              className="mt-2 w-full rounded-lg bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50"
              title={aiEnabled ? undefined : labels.aiNotConfigured}
            >
              {pending ? labels.aiGenerating : labels.aiGenerate}
            </button>
            {!aiEnabled && <p className="mt-1 text-[11px] text-muted-foreground">{labels.aiNotConfigured}</p>}
            {aiMsg && <p className="mt-2 rounded-lg bg-muted/60 px-2.5 py-1.5 text-[11px] text-muted-foreground">{aiMsg}</p>}
          </div>
        </section>
      </div>

      {/* Save + export bar */}
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-border bg-card p-4">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs text-muted-foreground">{labels.exportHint}</span>
          <button type="button" onClick={() => exportAs('csv')} disabled={columns.length === 0} className="rounded-lg border border-border px-2.5 py-1 text-xs font-medium hover:bg-accent/60 disabled:opacity-50">{labels.exportCsv}</button>
          <button type="button" onClick={() => exportAs('xlsx')} disabled={columns.length === 0} className="rounded-lg border border-border px-2.5 py-1 text-xs font-medium hover:bg-accent/60 disabled:opacity-50">{labels.exportXlsx}</button>
          <button type="button" onClick={() => exportAs('pdf')} disabled={columns.length === 0} className="rounded-lg border border-border px-2.5 py-1 text-xs font-medium hover:bg-accent/60 disabled:opacity-50">{labels.exportPdf}</button>
          <button type="button" onClick={() => exportAs('docx')} disabled={columns.length === 0} className="rounded-lg border border-border px-2.5 py-1 text-xs font-medium hover:bg-accent/60 disabled:opacity-50">{labels.exportDocx}</button>
        </div>
        <form action={saveReportAction}>
          <input type="hidden" name="id" value={reportId ?? ''} />
          <input type="hidden" name="name" value={name} />
          <input type="hidden" name="shared" value={shared ? 'true' : 'false'} />
          <input type="hidden" name="spec" value={JSON.stringify(buildSpec())} />
          <button
            type="submit"
            disabled={columns.length === 0 || !name.trim()}
            className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50"
          >
            {labels.save}
          </button>
        </form>
      </div>
    </div>
  );
}
