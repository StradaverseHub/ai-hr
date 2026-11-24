import {describe, expect, it} from 'vitest';
import * as XLSX from 'xlsx';
import {inspectImportWorksheets} from '../lib/spreadsheet';
import {PERSONNEL_CSV_FRAME} from '../lib/personnel-csv';

describe('import worksheet selection', () => {
  it.each(['xlsx', 'biff8'] as const)('counts and reads exactly the selected %s worksheet', async bookType => {
    const book = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([['Instructions'], ['Fill the data tab']]), 'Instructions');
    XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([['Header'], ['  ']]), 'Empty');
    const data = XLSX.utils.aoa_to_sheet([[PERSONNEL_CSV_FRAME], ['ID', 'Quantity', 'Note'], ['0007', 0, 'Line 1\nLine 2']]);
    XLSX.utils.sheet_add_aoa(data, [['0008', -2]], {origin: 'A15010'});
    XLSX.utils.book_append_sheet(book, data, 'Data');
    XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([['Private'], ['Hidden value']]), 'Hidden');
    book.Workbook = {Sheets: book.SheetNames.map(name => ({name, Hidden: name === 'Hidden' ? 1 : 0}))};
    const bytes: ArrayBuffer = XLSX.write(book, {bookType, type: 'array'});

    const inspected = await inspectImportWorksheets(bytes, true, ['Instructions']);
    expect(inspected.worksheets).toEqual([{name: 'Empty', rowCount: 0}, {name: 'Data', rowCount: 2}]);
    expect(inspected.read('Data', 5000)).toEqual({
      excelRows: [3, 15010],
      text: `${PERSONNEL_CSV_FRAME}\r\nID,Quantity,Note\r\n0007,0,"Line 1\nLine 2"\r\n0008,-2\r\n`,
    });
    expect(() => inspected.read('Hidden', 5000)).toThrow('EMPTY_SHEET');
    expect(() => inspected.read('Empty', 5000)).toThrow('EMPTY_SHEET');
    expect(() => inspected.read('Data', 30)).toThrow('FILE_TOO_LARGE');
  });
});
