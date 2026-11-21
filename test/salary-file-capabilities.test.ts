import { describe, expect, it } from 'vitest';
import { salaryFileBankGroups } from '../lib/salary-file-capabilities';
import { MY_BANKS, disbursementFormatFor } from '../lib/my-banks';

describe('current Salary File Format bank grouping', () => {
  const formats = [
    { id: 'my.ocbc.salary', bankKey: 'ocbc_bank', available: true },
    { id: 'my.maybank74.salary', bankKey: 'maybank', available: true },
  ];
  it('groups only executable current formats, while preserving legacy exporter metadata and every account choice', () => {
    const groups = salaryFileBankGroups(formats);
    expect(groups.supported.map(bank => bank.key).sort()).toEqual(['maybank', 'ocbc_bank']);
    expect(groups.other.map(bank => bank.key)).toEqual(expect.arrayContaining(['cimb','public_bank','rhb']));
    expect(new Set([...groups.supported, ...groups.other].map(bank => bank.key))).toEqual(new Set(MY_BANKS.map(bank => bank.key)));
    expect(disbursementFormatFor('cimb')).toBe('ibg_autopay');
    expect(disbursementFormatFor('rhb')).toBe('rhb_reflex');
  });
  it('moves a bank automatically when a real format becomes available, ignoring declared but unavailable formats', () => {
    const unready = [...formats, { id: 'future.salary', bankKey: 'rhb', available: false }];
    expect(salaryFileBankGroups(unready).other.some(bank => bank.key === 'rhb')).toBe(true);
    expect(salaryFileBankGroups(unready.map(format => ({...format, available: true}))).supported.map(bank=>bank.key)).toContain('rhb');
    expect(salaryFileBankGroups([]).supported).toEqual([]);
  });
});
