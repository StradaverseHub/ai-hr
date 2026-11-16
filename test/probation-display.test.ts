import {describe,expect,it} from 'vitest';
import {probationDate,probationIsoInstant,probationTimestamp} from '../lib/probation-display';

describe('Probation display formats (L2)',()=>{
 it('prints instants in the HR timezone whatever text form the database or the signing store used',()=>{
  expect(probationTimestamp('2026-11-16T04:11:38.493Z')).toBe('16/11/2026 12:11');
  expect(probationTimestamp('2026-11-16T12:11:54.756+08:00')).toBe('16/11/2026 12:11');
  // Postgres timestamptz::text: a space and a bare "+08" offset, which strict engines refuse as written.
  expect(probationIsoInstant('2026-11-16 12:11:54.756+08')).toBe('2026-11-16T12:11:54.756+08:00');
  expect(probationTimestamp('2026-11-16 12:11:54.756+08')).toBe('16/11/2026 12:11');
  expect(probationTimestamp('2026-11-15 23:30:00+00')).toBe('16/11/2026 07:30');
  expect(probationTimestamp(new Date('2026-11-16T04:11:38.493Z'))).toBe('16/11/2026 12:11');
 });
 it('keeps blanks as a dash and never invents a time for a value without an offset',()=>{
  expect(probationTimestamp(null)).toBe('—');expect(probationTimestamp(undefined)).toBe('—');expect(probationTimestamp('  ')).toBe('—');
  expect(probationTimestamp('2026-11-03')).toBe('2026-11-03');expect(probationTimestamp('not a time')).toBe('not a time');
  expect(probationIsoInstant('2026-11-16T12:11')).toBeNull();
 });
 it('prints calendar days from the string and instants as their HR-timezone day',()=>{
  expect(probationDate('2026-12-02')).toBe('02/12/2026');
  expect(probationDate('2026-11-15T20:00:00Z')).toBe('16/11/2026');
  expect(probationDate(null)).toBe('—');expect(probationDate('')).toBe('—');expect(probationDate('soon')).toBe('soon');
 });
});
