import {describe, expect, it} from 'vitest';
import {parseCsvRecords} from '../lib/csv';

describe('CSV import records', () => {
  it('ignores rows made entirely of empty or whitespace-only cells', () => {
    const text = ',,\r\nEmployee ID,Amount,Remark\r\n001,0,\r\n" ",,""\r\n,,\r\n002,,Needs review\r\n,,\r\n';
    expect(parseCsvRecords(text)).toEqual({
      headers: ['employee_id', 'amount', 'remark'],
      records: [
        {employee_id: '001', amount: '0', remark: ''},
        {employee_id: '002', amount: '', remark: 'Needs review'},
      ],
    });
  });

  it('can retain legacy row indexes when replaying an old import', () => {
    const text = 'Employee ID,Amount\n001,5\n,\n002,7\n';
    const {records} = parseCsvRecords(text, {preserveBlankRows: true});
    expect(records[2]).toEqual({employee_id: '002', amount: '7'});
  });
});
