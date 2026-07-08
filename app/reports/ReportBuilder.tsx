'use client';

/**
 * Custom Report Builder — the three-panel drag-and-drop designer (ADR-0074, c440b365).
 *   Left   — searchable, grouped Available Fields (drag onto the canvas, or click Add).
 *   Center — the Report Design Canvas: the ordered chosen columns (drag to reorder, up/down/remove, plus
 *            per-column alignment, relative width and freeze), a fidelity-accurate live preview
 *            (title / subtitle / description / logo / header / footer / alignment / frozen columns) and a
 *            page-count estimate.
 *   Right  — the full Report Properties set the reporter enumerated (name, category, orientation, paper
 *            size, margins, header & footer, date & number format, grouping, sorting, filters, page breaks,
 *            watermark, company logo, subtitle, description, totals + averages, freeze, role permissions,
 *            share) + the AI Report Designer (NL → a validated spec + smart recommendations, human-reviewed
 *            before save) + Save / Save-as-Template / export.
 *
 * All mutating operations are server actions; preview + AI drafting return data. Exports POST the current
 * spec to the export route. No employee data ever leaves the tenant via the AI path — only the field
 * catalogue + the redacted request (enforced server-side in core/report-ai.ts).
 */
import { useMemo, useState, useTransition } from 'react';
import { previewReport, draftReport, saveReportAction, saveAsTemplateAction } from './actions';
import type { CustomReportSpec } from '@/db/schema';
import type { ReportData } from '@/lib/report-export';

type FieldType = 'text' | 'date' | 'number' | 'currency' | 'status';
type Align = 'left' | 'center' | 'right';
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
type Recommendations = { extraColumns: { id: string; label: string }[]; bestFormat: string | null; note: string | null };

const isNumericType = (t: FieldType) => t === 'number' || t === 'currency';
const defaultAlign = (t: FieldType): Align =>
  t === 'number' || t === 'currency' ? 'right' : t === 'date' || t === 'status' ? 'center' : 'left';

export function ReportBuilder({
  reportId,
  name: initialName,
  shared: initialShared,
  dataset,
  datasets,
  initialSpec,
  aiEnabled,
  roles,
  verbs,
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
  roles: { id: string; label: string }[];
  verbs: { id: string; label: string }[];
  error?: string;
  toast?: string;
  labels: Labels;
}) {
  const L0 = initialSpec.layout ?? {};
  const [name, setName] = useState(initialName);
  const [shared, setShared] = useState(initialShared);
  const [activeDataset, setActiveDataset] = useState<DatasetView>(dataset);
  const [columns, setColumns] = useState<string[]>(initialSpec.columns ?? []);
  const [sort, setSort] = useState<CustomReportSpec['sort']>(initialSpec.sort ?? null);
  const [groupBy, setGroupBy] = useState<string | null>(initialSpec.groupBy ?? null);
  const [filters, setFilters] = useState<Record<string, string | number | null>>(initialSpec.filters ?? {});
  const [orientation, setOrientation] = useState<'portrait' | 'landscape'>(L0.orientation ?? 'landscape');
  const [paperSize, setPaperSize] = useState<NonNullable<typeof L0.paperSize>>(L0.paperSize ?? 'A4');
  const [margins, setMargins] = useState<NonNullable<typeof L0.margins>>(L0.margins ?? 'normal');
  const [subtitle, setSubtitle] = useState(L0.subtitle ?? '');
  const [description, setDescription] = useState(L0.description ?? '');
  const [header, setHeader] = useState(L0.header ?? '');
  const [footer, setFooter] = useState(L0.footer ?? '');
  const [watermark, setWatermark] = useState(L0.watermark ?? '');
  const [companyLogo, setCompanyLogo] = useState(L0.companyLogo ?? '');
  const [dateFormat, setDateFormat] = useState<NonNullable<typeof L0.dateFormat>>(L0.dateFormat ?? 'iso');
  const [numberFormat, setNumberFormat] = useState<NonNullable<typeof L0.numberFormat>>(L0.numberFormat ?? 'plain');
  const [pageBreakOn, setPageBreakOn] = useState<string | null>(L0.pageBreakOn ?? null);
  const [summary, setSummary] = useState<string[]>(L0.summary ?? []);
  const [averages, setAverages] = useState<string[]>(L0.averages ?? []);
  const [freeze, setFreeze] = useState<string[]>(L0.freeze ?? []);
  const [align, setAlign] = useState<Record<string, Align>>(L0.align ?? {});
  const [widths, setWidths] = useState<Record<string, number>>(L0.widths ?? {});
  const [permissions, setPermissions] = useState<Record<string, string[]>>(L0.permissions ?? {});
  const [search, setSearch] = useState('');
  const [preview, setPreview] = useState<ReportData | null>(null);
  const [aiText, setAiText] = useState('');
  const [aiMsg, setAiMsg] = useState<string | null>(null);
  const [recs, setRecs] = useState<Recommendations | null>(null);
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
    layout: {
      title: name || activeDataset.label,
      subtitle: subtitle || null,
      description: description || null,
      header: header || null,
      footer: footer || null,
      watermark: watermark || null,
      companyLogo: companyLogo || null,
      orientation,
      paperSize,
      margins,
      dateFormat,
      numberFormat,
      pageBreakOn,
      align: Object.keys(align).length ? align : undefined,
      widths: Object.keys(widths).length ? widths : undefined,
      freeze: freeze.length ? freeze : undefined,
      summary,
      averages,
      permissions: Object.keys(permissions).length ? permissions : undefined,
    },
  });

  const addColumn = (id: string) => setColumns((c) => (c.includes(id) ? c : [...c, id]));
  const removeColumn = (id: string) => {
    setColumns((c) => c.filter((x) => x !== id));
    setFreeze((f) => f.filter((x) => x !== id));
  };
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
  const setColAlign = (id: string, a: Align) =>
    setAlign((prev) => {
      const f = fieldById.get(id);
      const next = { ...prev };
      if (f && a === defaultAlign(f.type)) delete next[id];
      else next[id] = a;
      return next;
    });
  const setColWidth = (id: string, w: number) =>
    setWidths((prev) => {
      const next = { ...prev };
      if (!w || w === 1) delete next[id];
      else next[id] = w;
      return next;
    });
  const toggleFreeze = (id: string) =>
    setFreeze((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  const togglePerm = (role: string, verb: string) =>
    setPermissions((prev) => {
      const cur = prev[role] ?? [];
      const nextVerbs = cur.includes(verb) ? cur.filter((v) => v !== verb) : [...cur, verb];
      const next = { ...prev };
      if (nextVerbs.length) next[role] = nextVerbs;
      else delete next[role];
      return next;
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
    setAverages([]);
    setFreeze([]);
    setAlign({});
    setWidths({});
    setPageBreakOn(null);
    setPreview(null);
    setRecs(null);
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
        const L = res.spec.layout ?? {};
        setColumns(res.spec.columns);
        setSort(res.spec.sort ?? null);
        setGroupBy(res.spec.groupBy ?? null);
        setSummary(L.summary ?? []);
        setAverages(L.averages ?? []);
        setAlign(L.align ?? {});
        if (L.subtitle) setSubtitle(L.subtitle);
        if (res.spec.layout?.orientation) setOrientation(res.spec.layout.orientation);
        setRecs(res.recommendations ?? null);
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
    a.download = `${activeDataset.id}.${fmt === 'xlsx' ? 'xls' : fmt}`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const inputCls =
    'w-full rounded-lg border border-border bg-background px-2.5 py-1.5 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-primary/40';
  const labelCls = 'block text-xs font-medium text-muted-foreground';
  const numericSelectedFields = columns.map((c) => fieldById.get(c)).filter((f): f is Field => !!f && isNumericType(f.type));
  const frozenSet = new Set(freeze);
  // Preview page-count estimate: ~34 body rows per printed page at the chosen orientation.
  const previewPages = preview ? Math.max(1, Math.ceil(preview.rows.length / 34)) : 1;
  const effAlign = (id: string): Align => align[id] ?? defaultAlign(fieldById.get(id)?.type ?? 'text');
  const logoIsImage = companyLogo.startsWith('data:');

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
                    className="rounded-lg border border-border bg-background px-2.5 py-1.5 text-sm"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="flex min-w-0 items-center gap-2">
                        <span aria-hidden className="cursor-grab text-muted-foreground">⋮⋮</span>
                        <span className="truncate">{f?.label ?? id}</span>
                      </span>
                      <span className="flex shrink-0 items-center gap-1 text-muted-foreground">
                        <button type="button" onClick={() => move(id, -1)} aria-label={labels.moveUp} className="rounded px-1 hover:bg-accent/60">↑</button>
                        <button type="button" onClick={() => move(id, 1)} aria-label={labels.moveDown} className="rounded px-1 hover:bg-accent/60">↓</button>
                        <button type="button" onClick={() => removeColumn(id)} aria-label={labels.remove} className="rounded px-1 text-red-600 hover:bg-accent/60 dark:text-red-400">✕</button>
                      </span>
                    </div>
                    {/* Per-column formatting: alignment, relative width, freeze */}
                    <div className="mt-1 flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
                      <span>{labels.alignment}</span>
                      <select value={effAlign(id)} onChange={(e) => setColAlign(id, e.target.value as Align)} className="rounded border border-border bg-background px-1 py-0.5">
                        <option value="left">{labels.alignLeft}</option>
                        <option value="center">{labels.alignCenter}</option>
                        <option value="right">{labels.alignRight}</option>
                      </select>
                      <span>{labels.width}</span>
                      <input
                        type="number"
                        min={1}
                        max={6}
                        step={1}
                        value={widths[id] ?? 1}
                        onChange={(e) => setColWidth(id, Number(e.target.value))}
                        className="w-14 rounded border border-border bg-background px-1 py-0.5"
                      />
                      <label className="flex items-center gap-1">
                        <input type="checkbox" checked={frozenSet.has(id)} onChange={() => toggleFreeze(id)} />
                        {labels.freeze}
                      </label>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}

          {/* Live preview — fidelity: title/subtitle/description/logo/header/footer/alignment/frozen/pagination */}
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
              <div className={`relative rounded-lg border border-border bg-white p-3 text-black dark:bg-neutral-100 ${orientation === 'landscape' ? '' : ''}`}>
                {watermark && (
                  <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
                    <span className="rotate-[-24deg] select-none text-4xl font-bold uppercase text-black/5">{watermark}</span>
                  </div>
                )}
                <div className="relative">
                  <div className="mb-1 flex items-start justify-between">
                    <div>
                      <div className="text-sm font-bold">{name || activeDataset.label}</div>
                      {subtitle && <div className="text-[11px] text-neutral-600">{subtitle}</div>}
                      {header && <div className="text-[10px] text-neutral-500">{header}</div>}
                    </div>
                    {companyLogo &&
                      (logoIsImage ? (
                        /* eslint-disable-next-line @next/next/no-img-element */
                        <img src={companyLogo} alt="logo" className="max-h-10" />
                      ) : (
                        <span className="text-xs font-bold text-neutral-700">{companyLogo}</span>
                      ))}
                  </div>
                  {description && <div className="mb-1 text-[10px] text-neutral-500">{description}</div>}
                  <div className="overflow-x-auto">
                    <table className="w-full border-collapse text-left text-[11px]" style={{ fontFamily: 'Helvetica, Arial, sans-serif' }}>
                      <thead>
                        <tr className="bg-neutral-200">
                          {columns.map((id) => (
                            <th
                              key={id}
                              className={`whitespace-nowrap border border-neutral-300 px-2 py-1 font-semibold ${frozenSet.has(id) ? 'bg-indigo-100' : ''}`}
                              style={{ textAlign: effAlign(id) }}
                            >
                              {fieldById.get(id)?.label ?? id}
                            </th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {preview.rows.map((r, i) => (
                          <tr key={i} className="border-t border-neutral-200">
                            {columns.map((id, j) => (
                              <td
                                key={j}
                                className={`whitespace-nowrap border border-neutral-200 px-2 py-1 ${frozenSet.has(id) ? 'bg-indigo-50' : ''}`}
                                style={{ textAlign: effAlign(id) }}
                              >
                                {r[j] == null ? '' : String(r[j])}
                              </td>
                            ))}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  {footer && <div className="mt-1 text-center text-[10px] text-neutral-500">{footer}</div>}
                  <div className="mt-1 text-right text-[10px] text-neutral-400">
                    {paperSize} · {orientation === 'landscape' ? labels.landscape : labels.portrait} · {labels.pagesApprox}: {previewPages}
                  </div>
                </div>
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
              <label className={labelCls}>
                {labels.reportName}
                <input value={name} onChange={(e) => setName(e.target.value)} className={`${inputCls} mt-1`} />
              </label>
              {datasets.length > 1 && (
                <label className={labelCls}>
                  {labels.dataset}
                  <select value={activeDataset.id} onChange={(e) => switchDataset(e.target.value)} className={`${inputCls} mt-1`}>
                    {datasets.map((d) => (
                      <option key={d.id} value={d.id}>{d.label}</option>
                    ))}
                  </select>
                </label>
              )}
              <label className={labelCls}>
                {labels.subtitle}
                <input value={subtitle} onChange={(e) => setSubtitle(e.target.value)} className={`${inputCls} mt-1`} />
              </label>
              <label className={labelCls}>
                {labels.description}
                <textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={2} className={`${inputCls} mt-1 resize-none`} />
              </label>
              <label className={labelCls}>
                {labels.companyLogo}
                <input value={companyLogo} onChange={(e) => setCompanyLogo(e.target.value)} placeholder={labels.companyLogoHint} className={`${inputCls} mt-1`} />
              </label>

              <div className="grid grid-cols-2 gap-2">
                <label className={labelCls}>
                  {labels.orientation}
                  <select value={orientation} onChange={(e) => setOrientation(e.target.value as 'portrait' | 'landscape')} className={`${inputCls} mt-1`}>
                    <option value="portrait">{labels.portrait}</option>
                    <option value="landscape">{labels.landscape}</option>
                  </select>
                </label>
                <label className={labelCls}>
                  {labels.paperSize}
                  <select value={paperSize} onChange={(e) => setPaperSize(e.target.value as typeof paperSize)} className={`${inputCls} mt-1`}>
                    <option value="A4">A4</option>
                    <option value="A3">A3</option>
                    <option value="Letter">Letter</option>
                    <option value="Legal">Legal</option>
                  </select>
                </label>
                <label className={labelCls}>
                  {labels.margins}
                  <select value={margins} onChange={(e) => setMargins(e.target.value as typeof margins)} className={`${inputCls} mt-1`}>
                    <option value="narrow">{labels.marginNarrow}</option>
                    <option value="normal">{labels.marginNormal}</option>
                    <option value="wide">{labels.marginWide}</option>
                  </select>
                </label>
                <label className={labelCls}>
                  {labels.dateFormat}
                  <select value={dateFormat} onChange={(e) => setDateFormat(e.target.value as typeof dateFormat)} className={`${inputCls} mt-1`}>
                    <option value="iso">2026-07-08</option>
                    <option value="dmy">08/07/2026</option>
                    <option value="mdy">07/08/2026</option>
                    <option value="long">8 Jul 2026</option>
                  </select>
                </label>
                <label className={labelCls}>
                  {labels.numberFormat}
                  <select value={numberFormat} onChange={(e) => setNumberFormat(e.target.value as typeof numberFormat)} className={`${inputCls} mt-1`}>
                    <option value="plain">1234.5</option>
                    <option value="grouped">1,234.50</option>
                  </select>
                </label>
                <label className={labelCls}>
                  {labels.pageBreakOn}
                  <select value={pageBreakOn ?? ''} onChange={(e) => setPageBreakOn(e.target.value || null)} className={`${inputCls} mt-1`}>
                    <option value="">{labels.none}</option>
                    {columns.map((c) => (
                      <option key={c} value={c}>{fieldById.get(c)?.label ?? c}</option>
                    ))}
                  </select>
                </label>
              </div>

              <label className={labelCls}>
                {labels.header}
                <input value={header} onChange={(e) => setHeader(e.target.value)} className={`${inputCls} mt-1`} />
              </label>
              <label className={labelCls}>
                {labels.footer}
                <input value={footer} onChange={(e) => setFooter(e.target.value)} className={`${inputCls} mt-1`} />
              </label>
              <label className={labelCls}>
                {labels.watermark}
                <input value={watermark} onChange={(e) => setWatermark(e.target.value)} className={`${inputCls} mt-1`} />
              </label>

              <label className={labelCls}>
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
              <label className={labelCls}>
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
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <div className="mb-1 text-xs font-medium text-muted-foreground">{labels.summaryRow}</div>
                    <div className="space-y-1">
                      {numericSelectedFields.map((f) => (
                        <label key={f.id} className="flex items-center gap-2 text-xs">
                          <input
                            type="checkbox"
                            checked={summary.includes(f.id)}
                            onChange={(e) => setSummary((prev) => (e.target.checked ? [...prev, f.id] : prev.filter((x) => x !== f.id)))}
                          />
                          {f.label}
                        </label>
                      ))}
                    </div>
                  </div>
                  <div>
                    <div className="mb-1 text-xs font-medium text-muted-foreground">{labels.averagesRow}</div>
                    <div className="space-y-1">
                      {numericSelectedFields.map((f) => (
                        <label key={f.id} className="flex items-center gap-2 text-xs">
                          <input
                            type="checkbox"
                            checked={averages.includes(f.id)}
                            onChange={(e) => setAverages((prev) => (e.target.checked ? [...prev, f.id] : prev.filter((x) => x !== f.id)))}
                          />
                          {f.label}
                        </label>
                      ))}
                    </div>
                  </div>
                </div>
              )}

              {/* Role-based report permissions grid (Create/Edit/Delete/Export/Share/View/Manage Templates) */}
              <div>
                <div className="mb-1 text-xs font-medium text-muted-foreground">{labels.permissions}</div>
                <p className="mb-1 text-[10px] text-muted-foreground">{labels.permissionsHint}</p>
                <div className="overflow-x-auto">
                  <table className="text-[10px]">
                    <thead>
                      <tr className="text-muted-foreground">
                        <th className="pr-2 text-left font-medium">{labels.role}</th>
                        {verbs.map((v) => (
                          <th key={v.id} className="px-1 font-medium">{v.label}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {roles.map((role) => (
                        <tr key={role.id}>
                          <td className="pr-2 text-left">{role.label}</td>
                          {verbs.map((v) => (
                            <td key={v.id} className="px-1 text-center">
                              <input
                                type="checkbox"
                                checked={(permissions[role.id] ?? []).includes(v.id)}
                                onChange={() => togglePerm(role.id, v.id)}
                              />
                            </td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>

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
            {recs && (recs.extraColumns.length > 0 || recs.bestFormat || recs.note) && (
              <div className="mt-2 space-y-1 rounded-lg border border-border bg-muted/40 px-2.5 py-2 text-[11px]">
                <div className="font-semibold text-muted-foreground">{labels.recommendations}</div>
                {recs.extraColumns.length > 0 && (
                  <div className="flex flex-wrap items-center gap-1">
                    <span className="text-muted-foreground">{labels.suggestedColumns}:</span>
                    {recs.extraColumns.map((c) => (
                      <button
                        key={c.id}
                        type="button"
                        onClick={() => addColumn(c.id)}
                        className="rounded bg-primary/10 px-1.5 py-0.5 text-primary hover:bg-primary/20"
                      >
                        + {c.label}
                      </button>
                    ))}
                  </div>
                )}
                {recs.bestFormat && <div className="text-muted-foreground">{labels.bestFormat}: <b>{recs.bestFormat}</b></div>}
                {recs.note && <div className="text-muted-foreground">{recs.note}</div>}
              </div>
            )}
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
        <div className="flex items-center gap-2">
          {reportId && (
            <form action={saveAsTemplateAction}>
              <input type="hidden" name="id" value={reportId} />
              <button type="submit" className="rounded-lg border border-border px-3 py-2 text-sm font-medium hover:bg-accent/60">
                {labels.saveAsTemplate}
              </button>
            </form>
          )}
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
    </div>
  );
}
