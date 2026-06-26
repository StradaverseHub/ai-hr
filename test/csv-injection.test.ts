/**
 * CSV formula-injection hardening (Reporting & Analytics — chart-export slice). toCsv now neutralises a
 * cell that begins with = + - @ TAB CR by prefixing a single quote (OWASP mitigation), so an exported
 * employee name like `=HYPERLINK(...)` or `@SUM(...)` can't execute when the "Excel/CSV" download is
 * opened. Plain values are untouched (byte-identical to the pre-slice export).
 */
import { describe, expect, it } from 'vitest';
import { csvSafeCell, toCsv } from '../lib/csv';

describe('CSV formula-injection sanitisation', () => {
  it('prefixes a single quote on leading-formula cells', () => {
    expect(csvSafeCell('=HYPERLINK("http://evil","x")')).toBe("'=HYPERLINK(\"http://evil\",\"x\")");
    expect(csvSafeCell('@SUM(A1:A9)')).toBe("'@SUM(A1:A9)");
    expect(csvSafeCell('+1+1')).toBe("'+1+1");
    expect(csvSafeCell('-2+3')).toBe("'-2+3");
    expect(csvSafeCell('\tTabbed')).toBe("'\tTabbed");
  });

  it('leaves ordinary values untouched', () => {
    expect(csvSafeCell('Ann Tan')).toBe('Ann Tan');
    expect(csvSafeCell('ann@acme.test')).toBe('ann@acme.test'); // @ only triggers at position 0
    expect(csvSafeCell('5000.00')).toBe('5000.00');
    expect(csvSafeCell(1234)).toBe('1234');
    expect(csvSafeCell(null)).toBe('');
    expect(csvSafeCell(undefined)).toBe('');
  });

  it('toCsv quotes AND sanitises a malicious cell (quote prefix lands inside the field)', () => {
    const csv = toCsv([['Name'], ['=cmd|"/c calc"!A1']]);
    // The leading = is neutralised with a single quote; the embedded double-quote is RFC-escaped, and
    // because the cell still contains a quote it is wrapped — the formula never reaches the cell start.
    expect(csv).toBe('Name\r\n"\'=cmd|""/c calc""!A1"\r\n');
    expect(csv.includes('\n=')).toBe(false);
    expect(csv.includes(',=')).toBe(false);
  });

  it('does not alter the byte output of a clean roster row', () => {
    expect(toCsv([['Name', 'Dept'], ['Ann', 'Finance']])).toBe('Name,Dept\r\nAnn,Finance\r\n');
  });
});
