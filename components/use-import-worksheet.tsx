'use client';

import {useEffect, useId, useRef, useState} from 'react';
import {useTranslations} from 'next-intl';
import {Button, inputCls} from '@/components/ui';
import {importFileFormat, ImportFileError, MAX_IMPORT_FILE_BYTES, MAX_IMPORT_CSV_BYTES, readImportFile} from '@/lib/import-file';
import {parseCsvRecords} from '@/lib/csv';
import type {ImportWorksheet} from '@/lib/spreadsheet';

type Options = {maxFileBytes?: number; maxCsvBytes?: number; framed?: boolean; exclude?: readonly string[]};
const XLSX_SIGNATURE = [0x50, 0x4b, 0x03, 0x04];

/** The caller keeps its own validation and commit. Only the confirmed worksheet leaves the picker. */
export function useImportWorksheet() {
  const t = useTranslations('worksheetImport');
  const common = useTranslations('common');
  const id = useId();
  const active = useRef<{controller: AbortController; settle?: (name: string | null) => void} | null>(null);
  const [offer, setOffer] = useState<{file: string; worksheets: ImportWorksheet[]} | null>(null);
  const selectRef = useRef<HTMLSelectElement>(null);
  const [selected, setSelected] = useState('');
  const [confirmed, setConfirmed] = useState<ImportWorksheet | null>(null);

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
      const available = workbook.worksheets.filter(sheet => sheet.rowCount > 0);
      const name = await new Promise<string | null>(resolve => {
        request.settle = resolve;
        setSelected(available.length === 1 ? available[0].name : '');
        setOffer({file: file.name, worksheets: workbook.worksheets});
      });
      if (name === null || request.controller.signal.aborted) return null;
      const {text, excelRows} = workbook.read(name, options.maxCsvBytes ?? MAX_IMPORT_CSV_BYTES);
      setConfirmed({name, rowCount: excelRows.length});
      return {name: file.name, format, text, rowCount: excelRows.length, excelRows};
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
  const worksheetPicker = offer ? (
    <section className="mt-3 min-w-0 space-y-3 rounded-md border border-border bg-background p-3" aria-labelledby={id}>
      <div>
        <h3 id={id} className="text-sm font-semibold">{t('title')}</h3>
        <p className="break-all text-xs text-muted-foreground">{offer.file}</p>
      </div>
      <div className="space-y-1">
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
        <p id={`${id}-count`} role="status" className="text-xs text-muted-foreground">
          {choice ? t('count', {count: choice.rowCount}) : offer.worksheets.some(sheet => sheet.rowCount) ? t('hint') : t('noData')}
        </p>
      </div>
      <div className="flex flex-wrap gap-2">
        <Button type="button" size="sm" disabled={!choice?.rowCount} onClick={() => {
          if (!choice?.rowCount) return;
          setOffer(null);
          active.current?.settle?.(choice.name);
        }}>{t('confirm')}</Button>
        <Button type="button" size="sm" variant="outline" onClick={clearWorksheet}>{common('cancel')}</Button>
      </div>
    </section>
  ) : confirmed ? (
    <p role="status" className="mt-2 break-all text-xs text-muted-foreground">
      {t('selected', {name: confirmed.name, count: confirmed.rowCount})}
    </p>
  ) : null;

  return {readFile, readWorksheet, clearWorksheet, worksheetPicker, choosingWorksheet: offer !== null};
}
