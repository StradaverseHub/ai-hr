'use client';

import {useEffect, useId, useRef, useState} from 'react';
import {useTranslations} from 'next-intl';
import {Button, inputCls} from '@/components/ui';
import {importFileFormat, ImportFileError, MAX_IMPORT_FILE_BYTES, MAX_IMPORT_CSV_BYTES, readImportFile} from '@/lib/import-file';
import {parseCsvRecords} from '@/lib/csv';
import type {ImportWorksheet} from '@/lib/spreadsheet';

type Options = {maxFileBytes?: number; maxCsvBytes?: number; framed?: boolean; exclude?: readonly string[]; inspectOnly?: boolean; companions?: readonly string[]; multiple?: boolean};
const XLSX_SIGNATURE = [0x50, 0x4b, 0x03, 0x04];

/** The caller keeps its own validation and commit. Only the confirmed worksheet leaves the picker. */
export function useImportWorksheet() {
  const t = useTranslations('worksheetImport');
  const common = useTranslations('common');
  const id = useId();
  const active = useRef<{controller: AbortController; settle?: (names: string[] | null) => void} | null>(null);
  const [offer, setOffer] = useState<{file: string; worksheets: ImportWorksheet[]; companions: ImportWorksheet[]; multiple: boolean} | null>(null);
  const selectRef = useRef<HTMLSelectElement>(null);
  const [selected, setSelected] = useState('');
  const [extras, setExtras] = useState<string[]>([]);
  const [confirmed, setConfirmed] = useState<(ImportWorksheet & {file: string}) | null>(null);

  function clearWorksheet() {
    active.current?.controller.abort();
    active.current?.settle?.(null);
    active.current = null;
    setOffer(null);
    setConfirmed(null);
  }

  useEffect(() => () => {
    active.current?.controller.abort();
    active.current?.settle?.(null);
  }, []);
  useEffect(() => {
    if (offer) selectRef.current?.focus();
  }, [offer]);

  async function readWorksheet(file: File, options: Options = {}) {
    clearWorksheet();
    const format = importFileFormat(file.name);
    if (format !== 'xlsx' && format !== 'xls') throw new ImportFileError('UNSUPPORTED_FILE_TYPE');
    if (options.maxFileBytes !== undefined && file.size > options.maxFileBytes) throw new ImportFileError('FILE_TOO_LARGE');
    const request: NonNullable<typeof active.current> = {controller: new AbortController()};
    active.current = request;
    try {
      const {inspectImportWorksheets} = await import('@/lib/spreadsheet');
      const bytes = await file.arrayBuffer();
      if (request.controller.signal.aborted) return null;
      const signature = new Uint8Array(bytes, 0, Math.min(bytes.byteLength, XLSX_SIGNATURE.length));
      if (format === 'xlsx' && !XLSX_SIGNATURE.every((byte, index) => signature[index] === byte)) throw new ImportFileError('FILE_READ_FAILED');
      const workbook = await inspectImportWorksheets(bytes, options.framed, options.exclude);
      if (request.controller.signal.aborted) return null;
      const companionKeys = new Set(options.companions?.map(name => name.trim().toLowerCase()));
      const companions = workbook.worksheets.filter(sheet => companionKeys.has(sheet.name.trim().toLowerCase()));
      const worksheets = workbook.worksheets.filter(sheet => !companionKeys.has(sheet.name.trim().toLowerCase()));
      const available = worksheets.filter(sheet => sheet.rowCount > 0);
      const names = await new Promise<string[] | null>(resolve => {
        request.settle = resolve;
        setSelected(available.length === 1 ? available[0].name : '');
        setExtras(options.multiple ? available.length === 1 ? [available[0].name] : [] : companions.filter(sheet => sheet.rowCount).map(sheet => sheet.name));
        setOffer({file: file.name, worksheets, companions, multiple: options.multiple === true});
      });
      if (names === null || request.controller.signal.aborted) return null;
      const [worksheet, ...companionSheets] = names;
      const rowCount = workbook.worksheets.reduce((total, sheet) => total + (names.includes(sheet.name) ? sheet.rowCount : 0), 0);
      const {text, excelRows} = options.inspectOnly ? {text: '', excelRows: []} : workbook.read(worksheet, options.maxCsvBytes ?? MAX_IMPORT_CSV_BYTES);
      setConfirmed({name: names.join(' · '), rowCount, file: file.name});
      return {name: file.name, format, text, rowCount, excelRows, worksheet, worksheets: names, companionSheets};
    } finally {
      if (active.current === request) active.current = null;
    }
  }

  async function readFile(file: File, options: Options = {}) {
    if (importFileFormat(file.name) !== 'csv') return readWorksheet(file, {maxFileBytes: MAX_IMPORT_FILE_BYTES, ...options});
    clearWorksheet();
    const read = await readImportFile(file, options);
    return {...read, rowCount: parseCsvRecords(read.text).records.length, excelRows: undefined};
  }

  const choice = offer?.worksheets.find(sheet => sheet.name === selected);
  const selectedNames = offer?.multiple ? offer.worksheets.filter(sheet => extras.includes(sheet.name)).map(sheet => sheet.name) : choice?.rowCount ? [choice.name, ...extras] : [];
  const selectedCount = [...(offer?.worksheets ?? []), ...(offer?.companions ?? [])].reduce((total, sheet) => total + (selectedNames.includes(sheet.name) ? sheet.rowCount : 0), 0);
  const checks = (sheets: ImportWorksheet[]) => sheets.map(sheet => (
    <label className="flex min-h-9 min-w-0 items-center gap-2 text-sm" key={sheet.name}>
      <input type="checkbox" disabled={!sheet.rowCount} checked={extras.includes(sheet.name)} onChange={event => {
        const checked = event.currentTarget.checked;
        setExtras(previous => checked ? [...previous, sheet.name] : previous.filter(name => name !== sheet.name));
      }} />
      <span className="break-all">{t('option', {name: sheet.name, count: sheet.rowCount})}</span>
    </label>
  ));
  const worksheetPicker = offer ? (
    <section className="mt-3 min-w-0 space-y-3 rounded-md border border-border bg-background p-3" aria-labelledby={id}>
      <div>
        <h3 id={id} className="text-sm font-semibold">{t('title')}</h3>
        <p className="break-all text-xs text-muted-foreground">{offer.file}</p>
      </div>
      <div className="space-y-1">
        {offer.multiple ? <fieldset><legend className="text-sm font-medium">{t('multiple')}</legend>{checks(offer.worksheets)}</fieldset> : <>
        <label htmlFor={`${id}-sheet`} className="text-sm font-medium">{t('label')}</label>
        <select id={`${id}-sheet`} ref={selectRef} className={inputCls} value={selected} aria-describedby={`${id}-count`}
          onChange={event => setSelected(event.target.value)}>
          <option value="" disabled>{t('placeholder')}</option>
          {offer.worksheets.map(sheet => (
            <option key={sheet.name} value={sheet.name} disabled={!sheet.rowCount}>
              {t('option', {name: sheet.name, count: sheet.rowCount})}
            </option>
          ))}
        </select>
        {offer.companions.length > 0 && <fieldset><legend className="text-sm font-medium">{t('companions')}</legend>{checks(offer.companions)}</fieldset>}
        </>}
        <p id={`${id}-count`} role="status" className="text-xs text-muted-foreground">
          {selectedCount ? t('count', {count: selectedCount}) : offer.worksheets.some(sheet => sheet.rowCount) ? t('hint') : t('noData')}
        </p>
      </div>
      <div className="flex flex-wrap gap-2">
        <Button type="button" size="sm" disabled={!selectedNames.length} onClick={() => {
          if (!selectedNames.length) return;
          setOffer(null);
          active.current?.settle?.(selectedNames);
        }}>{offer.multiple ? t('confirmMultiple') : t('confirm')}</Button>
        <Button type="button" size="sm" variant="outline" onClick={clearWorksheet}>{common('cancel')}</Button>
      </div>
    </section>
  ) : confirmed ? (
    <p role="status" className="mt-2 break-all text-xs text-muted-foreground">
      <span>{confirmed.file}</span>{' · '}
      <span>{t('selected', {name: confirmed.name, count: confirmed.rowCount})}</span>
    </p>
  ) : null;

  return {readFile, readWorksheet, clearWorksheet, worksheetPicker, choosingWorksheet: offer !== null};
}
