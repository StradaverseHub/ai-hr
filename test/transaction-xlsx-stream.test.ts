import * as XLSX from 'xlsx';
import { expect, it } from 'vitest';
import { transactionXlsxStream, type TransactionCell } from '../lib/transaction-xlsx-stream';

async function workbook(rows: readonly TransactionCell[][]) {
  async function* source() { yield* rows; }
  const buffers: Buffer[] = [];
  for await (const chunk of transactionXlsxStream(['Code', 'Amount', 'Date', 'Notes'], source(), rows.length)) {
    buffers.push(chunk as Buffer);
  }
  const file = XLSX.read(Buffer.concat(buffers), { type: 'buffer', cellDates: true });
  return file.Sheets[file.SheetNames[0]];
}

it('writes real Excel dates, numbers and safe text while preserving leading zeroes', async () => {
  const sheet = await workbook([['000204', 13.5, { date: '2026-11-19' }, '=1+1 & <text>']]);
  expect(sheet.A2).toMatchObject({ t: 's', v: '000204' });
  expect(sheet.B2).toMatchObject({ t: 'n', v: 13.5 });
  expect(sheet.C2).toMatchObject({ t: 'd', v: new Date('2026-11-19T00:00:00Z') });
  expect(sheet.D2).toMatchObject({ t: 's', v: '=1+1 & <text>' });
  expect(sheet.D2.f).toBeUndefined();
});

it('writes headings for a filtered export with no rows', async () => {
  const sheet = await workbook([]);
  expect(sheet.A1.v).toBe('Code');
  expect(sheet.A2).toBeUndefined();
});
