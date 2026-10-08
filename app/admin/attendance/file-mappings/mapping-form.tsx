'use client';

/**
 * r424 (50ed39e1) — New / Edit Mapping. Everything the reporter's New Mapping page promised (plan items
 * 3-9): the details, a sample file shown but never imported, drag a field onto a column heading OR pick
 * the column (both write the same state), typed start/end positions with a numbered ruler and shading
 * for a fixed-width file, the In/Out code table pre-filled from the sample, a live "Test with the sample",
 * and the required-field refusal in the reporter's own words.
 *
 * r427 (50ed39e1 contest) — LOOK ONLY: six numbered sections of label-and-value rows (components/ui/
 * section-card.tsx), the fixed-width ruler in wrapping blocks of ten, the sample columns as a list on a narrow
 * section. Every state, handler, check and saved value is r424's, unchanged.
 *
 * The browser decides nothing that sticks. The required-field rule shown here is lib/clocking-file.ts
 * validateMappingDef — the same function the service runs before it saves — and the service re-runs it.
 */
import { useId, useMemo, useRef, useState, useTransition } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { UploadCloud } from 'lucide-react';
import { Button, inputCls } from '@/components/ui';
import { FormRow, SectionCard, typeHelpCls, typeLabelCls } from '@/components/ui/section-card';
import { Segmented } from '@/components/ui/segmented';
import { StackedBody, StackedHead, StackedRow, StackedTable, StackedTd, StackedTh } from '@/components/ui/stacked-table';
import { StatusWord } from '@/components/ui/status-word';
import {
  CLOCKING_FIELDS,
  REQUIRED_CLOCKING_FIELDS,
  SAMPLE_LINE_LIMIT,
  codesFromSample,
  decodeClockingBytes,
  extractFields,
  parseWithMapping,
  physicalLines,
  splitDelimited,
  validateMappingDef,
  type ClockingEncoding,
  type ClockingField,
  type ClockingMappingDef,
  type FieldSpec,
} from '@/lib/clocking-file';
import { MAX_IMPORT_CSV_BYTES } from '@/lib/import-file';
import { formatDmy } from '@/lib/date-display';
import { timeInKualaLumpur, todayInKualaLumpur } from '@/lib/hr-date';
import type { ClockingMappingInput } from '@/packs/attendance/service';
import { saveClockingMappingAction } from './actions';

type DelimChoice = 'comma' | 'tab' | 'semicolon' | 'other';
type CodeRow = { code: string; direction: 'in' | 'out' | '' };

const DELIM: Record<Exclude<DelimChoice, 'other'>, string> = { comma: ',', tab: '\t', semicolon: ';' };
const choiceOf = (d: string | null): DelimChoice =>
  d === ',' || d == null ? 'comma' : d === '\t' ? 'tab' : d === ';' ? 'semicolon' : 'other';

/** Strong / light / code shading for the fixed-width preview — the mockup's three tones. */
const SHADE: Record<ClockingField, 'strong' | 'light' | 'code'> = {
  cardId: 'strong',
  day: 'strong',
  year: 'strong',
  minute: 'strong',
  deviceId: 'light',
  month: 'light',
  hours: 'light',
  inOutCode: 'code',
};
const SHADE_CLS = {
  strong: 'bg-foreground text-background',
  light: 'bg-muted-foreground/25',
  code: 'bg-amber-200/60 dark:bg-amber-500/25',
} as const;

export function MappingForm({
  mappingId,
  initial,
}: {
  mappingId: string | null;
  initial: ClockingMappingInput | null;
}) {
  const t = useTranslations('clockingFile');
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  const [name, setName] = useState(initial?.name ?? '');
  const [deviceName, setDeviceName] = useState(initial?.deviceName ?? '');
  const [description, setDescription] = useState(initial?.description ?? '');
  const [active, setActive] = useState(initial?.active ?? true);
  const [fileType, setFileType] = useState<'csv' | 'txt'>(initial?.fileType ?? 'csv');
  const [layout, setLayout] = useState<'delimited' | 'fixed_width'>(initial?.layout ?? 'delimited');
  const [delimChoice, setDelimChoice] = useState<DelimChoice>(choiceOf(initial?.delimiter ?? ','));
  const [otherChar, setOtherChar] = useState(initial && choiceOf(initial.delimiter) === 'other' ? (initial.delimiter ?? '') : '');
  const [hasHeader, setHasHeader] = useState(initial?.hasHeader ?? false);
  const [encoding, setEncoding] = useState<ClockingEncoding>((initial?.encoding as ClockingEncoding) ?? 'utf-8');
  // Kept apart per layout, so trying Fixed width and coming back does not lose the column choices.
  const [colFields, setColFields] = useState<Partial<Record<ClockingField, { column: number }>>>(
    initial?.layout === 'delimited' ? (initial.fields as Partial<Record<ClockingField, { column: number }>>) : {},
  );
  const [posFields, setPosFields] = useState<Partial<Record<ClockingField, { start: number; end: number }>>>(
    initial?.layout === 'fixed_width' ? (initial.fields as Partial<Record<ClockingField, { start: number; end: number }>>) : {},
  );
  const [codes, setCodes] = useState<CodeRow[]>(initial?.inOutCodes ?? []);
  const [sampleBytes, setSampleBytes] = useState<Uint8Array | null>(null);
  const [sampleName, setSampleName] = useState(initial?.sampleFileName ?? '');
  const [savedLines] = useState<string[]>(initial?.sampleLines ?? []);
  const [fileError, setFileError] = useState<string | null>(null);
  const [submitted, setSubmitted] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);
  const [dragField, setDragField] = useState<ClockingField | null>(null);
  const [dropCol, setDropCol] = useState<number | null>(null);
  const [dragging, setDragging] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  // r427 — which fixed-width field is being typed in, so its positions are marked on the ruler. Look only.
  const [focusField, setFocusField] = useState<ClockingField | null>(null);
  const uid = useId();

  const delimiter = layout === 'fixed_width' ? null : delimChoice === 'other' ? otherChar.slice(0, 1) : DELIM[delimChoice];
  const fields: Partial<Record<ClockingField, FieldSpec>> = layout === 'delimited' ? colFields : posFields;
  const def: ClockingMappingDef = {
    fileType,
    layout,
    delimiter,
    hasHeader,
    encoding,
    fields,
    inOutCodes: codes.filter((c) => c.direction).map((c) => ({ code: c.code, direction: c.direction as 'in' | 'out' })),
  };

  // The sample: decoded from the bytes when a file was dropped this session (so a change of encoding
  // re-reads it), else the lines kept with the mapping.
  const sample = useMemo(() => {
    if (sampleBytes) {
      const all = physicalLines(decodeClockingBytes(sampleBytes, encoding));
      return { lines: all.slice(0, SAMPLE_LINE_LIMIT).map((l) => l.text), total: all.length };
    }
    return { lines: savedLines, total: null as number | null };
  }, [sampleBytes, encoding, savedLines]);
  const hasSample = sample.lines.length > 0;
  const dataLines = hasHeader ? sample.lines.slice(1) : sample.lines;
  const firstData = dataLines.find((l) => l.trim().length > 0) ?? '';

  const validation = validateMappingDef({ ...def, inOutCodes: codes.map((c) => ({ code: c.code, direction: c.direction as 'in' | 'out' })) });
  const showMissing = (submitted || hasSample) && validation.missing.length > 0;
  const fieldLabel = (f: ClockingField) => t(`fields.${f}`);

  const loadFile = async (f: File) => {
    setFileError(null);
    if (/\.(xlsx|xls)$/i.test(f.name)) {
      setFileError(t('form.excelRefused'));
      return;
    }
    if (f.size > MAX_IMPORT_CSV_BYTES * 2) {
      setFileError(t('form.fileTooLarge'));
      return;
    }
    try {
      const bytes = new Uint8Array(await f.arrayBuffer());
      setSampleBytes(bytes);
      setSampleName(f.name);
      if (/\.txt$/i.test(f.name)) setFileType('txt');
      if (/\.csv$/i.test(f.name)) setFileType('csv');
    } catch {
      setFileError(t('form.fileUnreadable'));
    }
  };

  const assignColumn = (f: ClockingField, column: number | null) => {
    setColFields((prev) => {
      const next = { ...prev };
      // One field per column: dropping a field onto a column already held moves the column to it.
      for (const k of CLOCKING_FIELDS) if (column != null && next[k]?.column === column && k !== f) delete next[k];
      if (column == null) delete next[f];
      else next[f] = { column };
      return next;
    });
    if (f === 'inOutCode' && column != null && codes.length === 0) prefillCodes({ ...def, fields: { ...colFields, inOutCode: { column } } });
  };
  const setPos = (f: ClockingField, which: 'start' | 'end', raw: string) => {
    const next = { ...posFields };
    const cur = next[f] ?? { start: 0, end: 0 };
    // Number('') is 0, which here correctly means "not typed yet".
    const n = raw.trim() === '' ? 0 : Math.max(0, Math.floor(Number(raw)) || 0);
    const upd = { ...cur, [which]: n };
    if (!upd.start && !upd.end) delete next[f];
    else next[f] = upd;
    setPosFields(next);
    if (f === 'inOutCode' && upd.start && upd.end && codes.length === 0) prefillCodes({ ...def, fields: next });
  };
  const prefillCodes = (d: ClockingMappingDef) => {
    if (!hasSample) return;
    const found = codesFromSample(sample.lines, d);
    if (found.length) setCodes(found.map((c) => ({ code: c.code, direction: c.direction ?? '' })));
  };
  const foundCodes = fields.inOutCode && hasSample ? codesFromSample(sample.lines, def).map((c) => c.code) : [];

  // Delimited preview grid.
  const grid = layout === 'delimited' && delimiter ? sample.lines.map((l) => splitDelimited(l, delimiter)) : [];
  const nCols = Math.min(40, Math.max(grid.reduce((n, r) => Math.max(n, r.length), 0), 1));
  const columnOwner = (col: number) => CLOCKING_FIELDS.find((f) => colFields[f]?.column === col) ?? null;
  const colOptions = Math.max(nCols, 10);

  // Fixed-width preview.
  const posOwner = (pos: number): ClockingField | null => {
    for (const f of CLOCKING_FIELDS) {
      const s = posFields[f];
      if (s && s.start >= 1 && s.end >= s.start && pos >= s.start && pos <= s.end) return f;
    }
    return null;
  };
  const shownFixed = sample.lines.slice(0, 8);
  const maxLen = Math.min(
    200,
    Math.max(
      shownFixed.reduce((n, l) => Math.max(n, l.length), 0),
      ...Object.values(posFields).map((s) => s?.end ?? 0),
      10,
    ),
  );

  const now = { date: todayInKualaLumpur(), time: timeInKualaLumpur() };
  const test = hasSample ? parseWithMapping(sample.lines.join('\n'), def, now).lines : [];

  const resultText = (l: (typeof test)[number]) => {
    if (!l.error) return null;
    if ((l.error === 'missing_value' || l.error === 'line_too_short') && l.errorField && !fields[l.errorField]) {
      return t('form.notMappedResult', { field: fieldLabel(l.errorField) });
    }
    if (l.error === 'unknown_in_out_code') return t('result.unknownCodeOf', { detail: l.code ?? '' });
    return t(`result.${l.error}`);
  };

  const save = () => {
    setSubmitted(true);
    setServerError(null);
    if (!name.trim()) {
      setServerError(t('form.nameRequired'));
      return;
    }
    if (validation.missing.length || validation.problems.length) return;
    const input: ClockingMappingInput = {
      name,
      description,
      deviceName,
      fileType,
      layout,
      delimiter,
      hasHeader,
      encoding,
      active,
      fields,
      inOutCodes: def.inOutCodes,
      sampleLines: sample.lines,
      sampleFileName: sampleName,
    };
    startTransition(async () => {
      const r = await saveClockingMappingAction(mappingId, input);
      if (r.ok) {
        router.push(`/admin/attendance/file-mappings/${r.id}`);
        router.refresh();
        return;
      }
      if (r.code === 'invalid') setServerError(null);
      else if (r.code === 'nameRequired' || r.code === 'nameTaken' || r.code === 'notFound') setServerError(t(`form.${r.code}`));
      else setServerError(t('form.fileUnreadable'));
    });
  };

  const shadeLegend = (
    <div className={`flex flex-wrap items-center gap-x-5 gap-y-1 ${typeHelpCls}`}>
      <span className="inline-flex items-center gap-1.5">
        <span className={`inline-block h-3 w-3 ${SHADE_CLS.strong}`} /> {t('form.shadeLegendStrong')}
      </span>
      <span className="inline-flex items-center gap-1.5">
        <span className={`inline-block h-3 w-3 ${SHADE_CLS.light}`} /> {t('form.shadeLegendLight')}
      </span>
      <span className="inline-flex items-center gap-1.5">
        <span className={`inline-block h-3 w-3 ${SHADE_CLS.code}`} /> {t('form.shadeLegendCode')}
      </span>
      <span>{t('form.shadeLegendNone')}</span>
    </div>
  );

  // r427 — the fixed-width preview in blocks of ten positions that wrap to the section's width, with no field
  // names on the ruler (they overlapped); each field is its own labelled row below. The field being typed in
  // is marked by an underline on its positions.
  const BLOCK = 10;
  const blocks = Array.from({ length: Math.ceil(maxLen / BLOCK) }, (_, b) =>
    Array.from({ length: Math.min(BLOCK, maxLen - b * BLOCK) }, (_, i) => b * BLOCK + i + 1),
  );
  const cellW = 'inline-block w-[14px] shrink-0 text-center';
  const focusMark = 'shadow-[inset_0_-2px_0_0_#f97316] monolith:shadow-[inset_0_-2px_0_0_var(--signal)]';
  const readsOf = (f: ClockingField) => (firstData && fields[f] ? (extractFields(firstData, def).values[f] ?? '') : '');
  const lineReads = (f: ClockingField) => (
    <span className={`${typeHelpCls} min-w-0 [overflow-wrap:anywhere]`}>
      {t('form.colLineReads')} <span className="whitespace-pre font-mono text-foreground monolith:text-ink">{readsOf(f) || '—'}</span>
    </span>
  );

  return (
    <div className="space-y-6">
      {/* 01 · DETAILS */}
      <SectionCard index={1} title={t('form.secDetails')}>
        <FormRow label={t('form.name')} htmlFor={`${uid}-name`} required>
          <input id={`${uid}-name`} className={inputCls} value={name} maxLength={100} onChange={(e) => setName(e.target.value)} />
        </FormRow>
        <FormRow label={t('form.device')} htmlFor={`${uid}-device`}>
          <input id={`${uid}-device`} className={inputCls} value={deviceName} maxLength={100} onChange={(e) => setDeviceName(e.target.value)} />
        </FormRow>
        <FormRow label={t('form.status')}>
          <Segmented
            label={t('form.status')}
            value={active ? 'active' : 'inactive'}
            onChange={(v) => setActive(v === 'active')}
            options={[
              { value: 'active', label: t('status.active') },
              { value: 'inactive', label: t('status.inactive') },
            ]}
          />
        </FormRow>
        <FormRow label={t('form.description')} htmlFor={`${uid}-description`}>
          <input
            id={`${uid}-description`}
            className={inputCls}
            value={description}
            maxLength={500}
            onChange={(e) => setDescription(e.target.value)}
          />
        </FormRow>
      </SectionCard>

      {/* 02 · FILE FORMAT */}
      <SectionCard index={2} title={t('sec.fileFormat')}>
        <FormRow label={t('form.fileType')} required>
          <Segmented
            label={t('form.fileType')}
            value={fileType}
            onChange={setFileType}
            options={[
              { value: 'csv', label: t('fileType.csv') },
              { value: 'txt', label: t('fileType.txt') },
            ]}
          />
        </FormRow>
        <FormRow label={t('form.layout')} required>
          <Segmented
            label={t('form.layout')}
            value={layout}
            onChange={setLayout}
            options={[
              { value: 'delimited', label: t('form.layoutDelimited') },
              { value: 'fixed_width', label: t('form.layoutFixed') },
            ]}
          />
        </FormRow>
        <FormRow label={t('form.delimiter')} required={layout === 'delimited'}>
          {layout === 'delimited' ? (
            <div className="flex flex-wrap items-center gap-2">
              <Segmented
                label={t('form.delimiter')}
                value={delimChoice}
                onChange={setDelimChoice}
                options={[
                  { value: 'comma', label: t('form.delimComma') },
                  { value: 'tab', label: t('form.delimTab') },
                  { value: 'semicolon', label: t('form.delimSemicolon') },
                  { value: 'other', label: t('form.delimOther') },
                ]}
              />
              {delimChoice === 'other' && (
                <input
                  aria-label={t('form.otherChar')}
                  className={`${inputCls} w-16 text-center font-mono`}
                  value={otherChar}
                  maxLength={1}
                  onChange={(e) => setOtherChar(e.target.value.slice(0, 1))}
                />
              )}
            </div>
          ) : (
            <div className={`${inputCls} flex h-auto min-h-9 items-center bg-muted/60 text-muted-foreground`}>{t('form.delimiterNotUsed')}</div>
          )}
        </FormRow>
        <FormRow label={t('form.hasHeader')}>
          <Segmented
            label={t('form.hasHeader')}
            value={hasHeader ? 'yes' : 'no'}
            onChange={(v) => setHasHeader(v === 'yes')}
            options={[
              { value: 'yes', label: t('form.yes') },
              { value: 'no', label: t('form.no') },
            ]}
          />
        </FormRow>
        <FormRow label={t('form.encoding')} htmlFor={`${uid}-encoding`} help={t('form.encodingHint')}>
          <select id={`${uid}-encoding`} className={inputCls} value={encoding} onChange={(e) => setEncoding(e.target.value as ClockingEncoding)}>
            <option value="utf-8">{t('form.encodingUtf8')}</option>
            <option value="utf-16le">{t('form.encodingUtf16le')}</option>
            <option value="utf-16be">{t('form.encodingUtf16be')}</option>
            <option value="windows-1252">{t('form.encodingWin1252')}</option>
          </select>
        </FormRow>
      </SectionCard>

      {/* 03 · SAMPLE FILE */}
      <SectionCard index={3} title={t('form.secSample')}>
        <input
          ref={fileRef}
          type="file"
          accept=".csv,.txt,text/csv,text/plain"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void loadFile(f);
            e.target.value = '';
          }}
        />
        <FormRow label={t('form.secSample')}>
          {hasSample ? (
            <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-dashed border-border bg-card px-4 py-3 text-sm monolith:rounded-none monolith:border-ink monolith:bg-transparent">
              <span className="min-w-0 break-all">
                <strong>{sampleName || '—'}</strong>{' '}
                <span className="text-muted-foreground monolith:text-mid">
                  ·{' '}
                  {sample.total != null
                    ? t('form.sampleLoaded', { lines: sample.total, shown: sample.lines.length })
                    : t('form.sampleKept', { shown: sample.lines.length })}
                </span>
              </span>
              <button
                type="button"
                className="text-sm text-primary underline underline-offset-2 monolith:text-ink"
                onClick={() => fileRef.current?.click()}
              >
                {t('form.replaceFile')}
              </button>
            </div>
          ) : (
            <div
              role="button"
              tabIndex={0}
              onClick={() => fileRef.current?.click()}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  fileRef.current?.click();
                }
              }}
              onDragOver={(e) => {
                if (e.dataTransfer.types.includes('Files')) {
                  e.preventDefault();
                  setDragging(true);
                }
              }}
              onDragLeave={() => setDragging(false)}
              onDrop={(e) => {
                e.preventDefault();
                setDragging(false);
                const f = e.dataTransfer.files?.[0];
                if (f) void loadFile(f);
              }}
              className={`flex cursor-pointer flex-col items-center justify-center gap-2 rounded-lg border-2 border-dashed px-4 py-8 text-center transition-colors monolith:rounded-none monolith:border monolith:border-ink ${
                dragging ? 'border-primary bg-primary/5' : 'border-border hover:border-primary/50 hover:bg-muted/40'
              }`}
            >
              <UploadCloud className="h-6 w-6 text-muted-foreground" aria-hidden />
              <div className="text-sm font-medium">{t('form.dropSample')}</div>
              <p className={typeHelpCls}>{t('form.dropSampleHint')}</p>
            </div>
          )}
          {fileError && <p className="mt-2 text-sm text-destructive monolith:text-signal-text">{fileError}</p>}
          {!hasSample && <p className={`mt-2 ${typeHelpCls}`}>{t('form.noSample')}</p>}
        </FormRow>
      </SectionCard>

      {/* 04 · FIELD MAPPING / POSITIONS */}
      <SectionCard
        index={4}
        title={layout === 'delimited' ? t('form.secFields') : t('form.secPositions')}
        description={hasSample ? (layout === 'delimited' ? t('form.dragHint') : t('form.positionHint')) : undefined}
      >
        {hasSample && layout === 'delimited' && (
          <div className="space-y-4 pb-2">
            <div className="flex flex-wrap gap-2">
              {CLOCKING_FIELDS.map((f) => {
                const done = !!colFields[f];
                return (
                  <span
                    key={f}
                    draggable
                    onDragStart={(e) => {
                      e.dataTransfer.setData('text/plain', f);
                      e.dataTransfer.effectAllowed = 'move';
                      setDragField(f);
                    }}
                    onDragEnd={() => {
                      setDragField(null);
                      setDropCol(null);
                    }}
                    className={`cursor-grab select-none rounded px-2.5 py-1 text-sm active:cursor-grabbing monolith:rounded-none ${
                      done
                        ? 'bg-foreground text-background'
                        : 'border border-dashed border-primary bg-primary/10 text-primary monolith:border-ink monolith:bg-transparent monolith:text-ink'
                    } ${dragField === f ? 'opacity-70 ring-2 ring-primary' : ''}`}
                  >
                    <span aria-hidden className="mr-1 opacity-60">
                      ⠿
                    </span>
                    {fieldLabel(f)}
                    {done ? ' ✓' : ''}
                  </span>
                );
              })}
            </div>
            {/* The sample as columns: a table you can drop a field onto on a wide section; on a narrow one a
                list of columns (the column is then chosen in the rows below — dragging needs a mouse). */}
            <div className="@container min-w-0">
              <div className="hidden overflow-x-auto rounded-md border border-border @3xl:block monolith:rounded-none monolith:border-0">
                <table className="w-full text-sm">
                  <thead className="bg-muted/50 text-left text-xs text-muted-foreground monolith:bg-transparent monolith:font-mono monolith:text-[11px] monolith:tracking-[0.12em] monolith:text-mid">
                    <tr>
                      <th className="px-3 py-2 font-medium uppercase monolith:border-b monolith:border-ink monolith:font-normal">{t('form.line')}</th>
                      {Array.from({ length: nCols }, (_, i) => i + 1).map((col) => {
                        const owner = columnOwner(col);
                        return (
                          <th
                            key={col}
                            onDragOver={(e) => {
                              e.preventDefault();
                              setDropCol(col);
                            }}
                            onDragLeave={() => setDropCol((c) => (c === col ? null : c))}
                            onDrop={(e) => {
                              e.preventDefault();
                              const f = (e.dataTransfer.getData('text/plain') || dragField) as ClockingField | null;
                              if (f && (CLOCKING_FIELDS as readonly string[]).includes(f)) assignColumn(f, col);
                              setDropCol(null);
                              setDragField(null);
                            }}
                            className={`min-w-28 px-3 py-2 align-top font-medium monolith:border-b monolith:border-ink monolith:font-normal ${dropCol === col ? 'bg-primary/15' : ''}`}
                          >
                            <div className="uppercase">{t('form.column', { n: col })}</div>
                            <div className="mt-1 h-5">
                              {owner ? (
                                <span className="rounded bg-foreground px-1.5 py-0.5 text-[11px] uppercase text-background monolith:rounded-none">{fieldLabel(owner)}</span>
                              ) : dragField ? (
                                <span className="rounded border border-dashed border-primary px-1.5 py-0.5 text-[11px] uppercase text-primary">
                                  {t('form.dropHere')}
                                </span>
                              ) : null}
                            </div>
                          </th>
                        );
                      })}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border font-mono text-xs monolith:divide-hairline">
                    {grid.slice(0, 6).map((cells, i) => (
                      <tr key={i} className={hasHeader && i === 0 ? 'italic text-muted-foreground' : ''}>
                        <td className="px-3 py-2 text-muted-foreground">{hasHeader && i === 0 ? t('form.headerLine') : i + 1}</td>
                        {Array.from({ length: nCols }, (_, c) => (
                          <td key={c} className="whitespace-pre px-3 py-2">
                            {cells[c] ?? ''}
                          </td>
                        ))}
                      </tr>
                    ))}
                    {grid.length > 6 && (
                      <tr>
                        <td className="px-3 py-2 text-muted-foreground">…</td>
                        <td colSpan={nCols} className="px-3 py-2 font-sans text-muted-foreground">
                          {t('form.moreLines', { count: grid.length - 6 })}
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
              <dl className="grid grid-cols-1 @3xl:hidden" data-sample-columns>
                {Array.from({ length: nCols }, (_, i) => i + 1).map((col) => {
                  const owner = columnOwner(col);
                  const firstTwo = (hasHeader ? grid.slice(1) : grid).slice(0, 2).map((r) => r[col - 1] ?? '');
                  return (
                    <div key={col} className="flex min-w-0 flex-wrap items-baseline justify-between gap-x-3 gap-y-1 border-b border-border py-2 monolith:border-hairline">
                      <dt className={typeLabelCls}>{t('form.column', { n: col })}</dt>
                      <dd className="m-0 flex min-w-0 flex-wrap items-baseline gap-x-3 gap-y-1">
                        <span className="whitespace-pre font-mono text-xs [overflow-wrap:anywhere]">{firstTwo.join('   ')}</span>
                        {owner && (
                          <span className="rounded bg-foreground px-1.5 py-0.5 text-[11px] uppercase text-background monolith:rounded-none">{fieldLabel(owner)}</span>
                        )}
                      </dd>
                    </div>
                  );
                })}
              </dl>
            </div>
          </div>
        )}

        {hasSample && layout === 'fixed_width' && (
          <div className="space-y-3 pb-2">
            <div className="flex flex-wrap gap-x-4 gap-y-3 font-mono text-sm" data-ruler>
              {blocks.map((positions, b) => (
                <div key={b} className="flex flex-col gap-0.5" data-ruler-block>
                  <div className="flex text-[10px] text-muted-foreground monolith:text-mid" aria-hidden>
                    {positions.map((pos) => (
                      <span key={pos} className={`${cellW} relative`}>
                        {pos === positions[0] || pos % 5 === 0 ? <span className="absolute left-1/2 -translate-x-1/2">{pos}</span> : '·'}
                      </span>
                    ))}
                  </div>
                  {shownFixed.map((line, li) => (
                    <div key={li} className={`flex ${hasHeader && li === 0 ? 'italic opacity-60' : ''}`}>
                      {positions.map((pos) => {
                        const owner = posOwner(pos);
                        const ch = line[pos - 1] ?? '';
                        return (
                          <span
                            key={pos}
                            className={`${cellW} ${owner ? SHADE_CLS[SHADE[owner]] : ''} ${owner && owner === focusField ? focusMark : ''}`}
                            title={owner ? `${fieldLabel(owner)} · ${pos}` : String(pos)}
                          >
                            {ch === ' ' || ch === '' ? ' ' : ch}
                          </span>
                        );
                      })}
                    </div>
                  ))}
                </div>
              ))}
            </div>
            {shadeLegend}
          </div>
        )}

        {CLOCKING_FIELDS.map((f) => {
          const req = REQUIRED_CLOCKING_FIELDS.includes(f);
          return layout === 'delimited' ? (
            <FormRow key={f} label={fieldLabel(f)} htmlFor={`${uid}-col-${f}`} required={req}>
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                <select
                  id={`${uid}-col-${f}`}
                  aria-label={fieldLabel(f)}
                  className={`${inputCls} w-full max-w-56`}
                  value={colFields[f]?.column ?? ''}
                  onChange={(e) => assignColumn(f, e.target.value ? Number(e.target.value) : null)}
                >
                  <option value="">{t('form.chooseColumn')}</option>
                  {Array.from({ length: colOptions }, (_, i) => i + 1).map((c) => (
                    <option key={c} value={c}>
                      {t('form.column', { n: c })}
                    </option>
                  ))}
                </select>
                {lineReads(f)}
              </div>
            </FormRow>
          ) : (
            <FormRow key={f} label={fieldLabel(f)} htmlFor={`${uid}-start-${f}`} required={req}>
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                <span aria-hidden className={`inline-block h-3 w-3 shrink-0 border border-border ${SHADE_CLS[SHADE[f]]}`} />
                <input
                  id={`${uid}-start-${f}`}
                  aria-label={`${fieldLabel(f)} ${t('form.colStart')}`}
                  inputMode="numeric"
                  className={`${inputCls} w-20`}
                  value={posFields[f]?.start || ''}
                  onFocus={() => setFocusField(f)}
                  onBlur={() => setFocusField((c) => (c === f ? null : c))}
                  onChange={(e) => setPos(f, 'start', e.target.value)}
                />
                <span aria-hidden className="text-muted-foreground">
                  –
                </span>
                <input
                  aria-label={`${fieldLabel(f)} ${t('form.colEnd')}`}
                  inputMode="numeric"
                  className={`${inputCls} w-20`}
                  value={posFields[f]?.end || ''}
                  onFocus={() => setFocusField(f)}
                  onBlur={() => setFocusField((c) => (c === f ? null : c))}
                  onChange={(e) => setPos(f, 'end', e.target.value)}
                />
                {lineReads(f)}
              </div>
            </FormRow>
          );
        })}
        <div className="space-y-1 pt-3">
          <p className={typeHelpCls}>{t('form.spacesHint')}</p>
          {layout === 'fixed_width' && <p className={typeHelpCls}>{t('form.shortLineHint')}</p>}
        </div>

        {(showMissing || (submitted && validation.problems.length > 0)) && (
          <div
            role="alert"
            className="mt-4 rounded-md border border-destructive/40 bg-destructive/5 px-4 py-3 text-sm text-destructive monolith:rounded-none monolith:border-0 monolith:border-l-2 monolith:border-signal monolith:bg-transparent monolith:text-signal-text"
          >
            <p className="font-semibold">{t('form.cannotSave')}</p>
            {validation.missing.length > 0 && <p>{t('form.missingFields', { fields: validation.missing.map(fieldLabel).join(', ') })}</p>}
            {validation.problems.map((p) => (
              <p key={p}>{t(`form.problem.${p}`)}</p>
            ))}
          </div>
        )}
      </SectionCard>

      {/* 05 · IN / OUT CODE VALUES */}
      <SectionCard index={5} title={t('form.codesTitle')} description={fields.inOutCode ? t('form.codesUsed') : undefined}>
        {fields.inOutCode ? (
          <div className="space-y-3">
            <table className="w-full max-w-2xl text-sm">
              <thead className="text-left text-xs uppercase tracking-wide text-muted-foreground monolith:font-mono monolith:text-[11px] monolith:tracking-[0.12em] monolith:text-mid">
                <tr>
                  <th className="py-2 pr-3 font-medium monolith:font-normal">{t('form.colDeviceCode')}</th>
                  <th className="py-2 pr-3 font-medium monolith:font-normal">{t('form.colMeaning')}</th>
                  <th className="py-2" />
                </tr>
              </thead>
              <tbody className="divide-y divide-border border-t border-border monolith:divide-hairline monolith:border-ink">
                {codes.map((c, i) => (
                  <tr key={i}>
                    <td className="py-2 pr-3">
                      <input
                        aria-label={t('form.colDeviceCode')}
                        className={`${inputCls} w-20 font-mono sm:w-28`}
                        value={c.code}
                        maxLength={20}
                        onChange={(e) => setCodes((cs) => cs.map((x, j) => (j === i ? { ...x, code: e.target.value } : x)))}
                      />
                    </td>
                    <td className="py-2 pr-3">
                      <select
                        aria-label={t('form.colMeaning')}
                        className={`${inputCls} min-w-32`}
                        value={c.direction}
                        onChange={(e) =>
                          setCodes((cs) => cs.map((x, j) => (j === i ? { ...x, direction: e.target.value as CodeRow['direction'] } : x)))
                        }
                      >
                        <option value="">{t('form.chooseMeaning')}</option>
                        <option value="in">{t('direction.in')}</option>
                        <option value="out">{t('direction.out')}</option>
                      </select>
                    </td>
                    <td className="py-2 text-right">
                      <button
                        type="button"
                        className="text-muted-foreground hover:text-foreground monolith:underline"
                        onClick={() => setCodes((cs) => cs.filter((_, j) => j !== i))}
                      >
                        {t('form.remove')}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <button
              type="button"
              className="text-sm text-primary underline underline-offset-2 monolith:text-ink"
              onClick={() => setCodes((cs) => [...cs, { code: '', direction: '' }])}
            >
              {t('form.addCode')}
            </button>
            <p className={typeHelpCls}>{foundCodes.length ? t('form.codesFound', { codes: foundCodes.join(', ') }) : t('form.codesNone')}</p>
          </div>
        ) : null}
        <p className={`${fields.inOutCode ? 'mt-1' : ''} ${typeHelpCls}`}>{t('form.noCodeHint')}</p>
      </SectionCard>

      {/* 06 · TEST WITH THE SAMPLE */}
      <SectionCard index={6} title={t('form.secTest')} description={t('form.testIntro')}>
        {hasSample ? (
          <StackedTable label={t('form.secTest')}>
            <StackedHead>
              <StackedTh>{t('form.line')}</StackedTh>
              <StackedTh>{t('form.colCardId')}</StackedTh>
              {fields.deviceId && <StackedTh>{t('form.colDeviceId')}</StackedTh>}
              <StackedTh>{t('form.colDate')}</StackedTh>
              <StackedTh>{t('form.colTime')}</StackedTh>
              <StackedTh>{t('form.colInOut')}</StackedTh>
              <StackedTh>{t('form.colResult')}</StackedTh>
            </StackedHead>
            <StackedBody>
              {test.map((l) => {
                const r = resultText(l);
                return (
                  <StackedRow key={l.lineNo}>
                    <StackedTd label={t('form.line')} role="title-inline" className="text-muted-foreground monolith:text-mid">
                      {l.lineNo}
                    </StackedTd>
                    <StackedTd label={t('form.colCardId')} className="font-mono text-xs">
                      {l.cardRef || '—'}
                    </StackedTd>
                    {fields.deviceId && (
                      <StackedTd label={t('form.colDeviceId')} className="font-mono text-xs">
                        {l.deviceRef ?? '—'}
                      </StackedTd>
                    )}
                    <StackedTd label={t('form.colDate')} className="tabular-nums">
                      {l.date ? formatDmy(l.date) : l.dateText || '—'}
                    </StackedTd>
                    <StackedTd label={t('form.colTime')} className="tabular-nums">
                      {l.time ? l.time.slice(0, 5) : l.timeText || '—'}
                    </StackedTd>
                    <StackedTd label={t('form.colInOut')}>{l.direction ? t(`direction.${l.direction}`) : (l.code ?? '—')}</StackedTd>
                    <StackedTd label={t('form.colResult')} role="aside" hideLabel>
                      <StatusWord tone={r ? 'signal' : 'ink'} className={r ? 'text-destructive' : 'text-emerald-700 dark:text-emerald-400'}>
                        {r ?? t('form.readable')}
                      </StatusWord>
                    </StackedTd>
                  </StackedRow>
                );
              })}
            </StackedBody>
          </StackedTable>
        ) : (
          <p className={typeHelpCls}>{t('form.testNoSample')}</p>
        )}
      </SectionCard>

      {serverError && (
        <div
          role="alert"
          className="rounded-md border border-destructive/40 bg-destructive/5 px-4 py-3 text-sm text-destructive monolith:rounded-none monolith:border-0 monolith:border-l-2 monolith:border-signal monolith:bg-transparent monolith:text-signal-text"
        >
          {serverError}
        </div>
      )}
      <div className="flex flex-wrap justify-end gap-2">
        <Link
          href="/admin/attendance/file-mappings"
          className="inline-flex min-h-9 items-center rounded-md border border-input px-4 text-sm hover:bg-muted monolith:rounded-none monolith:border-ink"
        >
          {t('form.cancel')}
        </Link>
        <Button type="button" onClick={save} disabled={pending}>
          {pending ? t('form.saving') : t('form.save')}
        </Button>
      </div>
    </div>
  );
}
