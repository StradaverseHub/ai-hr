/**
 * Employee ID shared validator (feedback 38668d9b; cap lifted to 30 by de2823cc) — pure unit test, no DB
 * harness. Locks the format contract HR keys against: alphanumeric + dash, max 30 chars, uppercase-
 * normalized, case-insensitive, and the "CODE · Name" label helper. The DB-level uniqueness + service
 * behaviour are covered by the integration suite; this pins the surface every path (hire form, import,
 * edit) shares.
 */
import { describe, it, expect } from 'vitest';
import {
  normalizeEmployeeCode,
  isValidEmployeeCode,
  requireEmployeeCode,
  employeeLabel,
  EMPLOYEE_CODE_MAX_LEN,
} from '../lib/employee-code';

describe('employee-code validator', () => {
  it('normalizes: trims + uppercases', () => {
    expect(normalizeEmployeeCode('  emp-0001 ')).toBe('EMP-0001');
    expect(normalizeEmployeeCode(null)).toBe('');
    expect(normalizeEmployeeCode(undefined)).toBe('');
  });

  it('accepts valid codes (letters/numbers/dash, up to 30 chars)', () => {
    expect(isValidEmployeeCode('EMP-0001')).toBe(true);
    expect(isValidEmployeeCode('A1')).toBe(true);
    expect(isValidEmployeeCode('E12345678')).toBe(true); // 9 (old cap) still fine
    expect(isValidEmployeeCode('E123456789')).toBe(true); // 10 — allowed since de2823cc
    expect(isValidEmployeeCode('CHINHIN-HQ-000001-MY')).toBe(true); // reporter's 20-char example
    expect(isValidEmployeeCode('A'.repeat(30))).toBe(true); // exactly 30
    expect(isValidEmployeeCode('emp-0001')).toBe(true); // normalized before check
  });

  it('rejects invalid codes', () => {
    expect(isValidEmployeeCode('A'.repeat(31))).toBe(false); // 31 chars — over the ceiling
    expect(isValidEmployeeCode('EMP 001')).toBe(false); // space
    expect(isValidEmployeeCode('EMP_001')).toBe(false); // underscore
    expect(isValidEmployeeCode('')).toBe(false);
    expect(isValidEmployeeCode(null)).toBe(false);
  });

  it('MAX_LEN is 30', () => {
    expect(EMPLOYEE_CODE_MAX_LEN).toBe(30);
  });

  it('requireEmployeeCode returns the normalized value or throws a clear error', () => {
    expect(requireEmployeeCode(' emp-0001 ')).toBe('EMP-0001');
    expect(requireEmployeeCode('chinhin-hq-000001-my')).toBe('CHINHIN-HQ-000001-MY');
    expect(() => requireEmployeeCode('')).toThrow(/required/i);
    expect(() => requireEmployeeCode('A'.repeat(31))).toThrow(/at most 30/i);
    expect(() => requireEmployeeCode('EMP 001')).toThrow(/letters, numbers and dashes/i);
  });

  it('employeeLabel prefixes the code with the name, degrading gracefully', () => {
    expect(employeeLabel('EMP-0001', 'Aisyah')).toBe('EMP-0001 · Aisyah');
    expect(employeeLabel(null, 'Aisyah')).toBe('Aisyah');
    expect(employeeLabel('', 'Aisyah')).toBe('Aisyah');
  });
});
