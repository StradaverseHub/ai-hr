/**
 * The employee-search RULE, now that it is shared (r179 W1).
 *
 * Pure matching rules belong here. The PostgreSQL file personnel-full-width-search.test.ts
 * retains the actual list/detail permission boundaries; personnel-search-layout-contract.test.ts
 * retains source wiring checks. Those files no longer pay database fixture cost for these pure cases.
 *
 * THE LAST TEST IS THE POINT OF THE OTHERS. An extraction is only safe while there is exactly ONE
 * implementation — a re-export that quietly becomes a second copy is how two screens start disagreeing
 * about who "emp0008" is. So identity is asserted, not just equivalence.
 */
import { describe, expect, it } from 'vitest';

import { EMPLOYEE_SEARCH_RESULT_CAP, matchEmployees } from '../lib/employee-search';
import {
  SWITCHER_RESULT_CAP,
  switcherHref,
  matchEmployees as personnelMatchEmployees,
} from '../app/(app)/admin/personnel/employee-search';

const people = [
  { employmentId: 'e1', name: 'Aisha Rahman', employeeCode: 'EMP-0008' },
  { employmentId: 'e2', name: 'Bala Krishnan', employeeCode: 'EMP-0081' },
  { employmentId: 'e3', name: 'Chan Wei Ming', employeeCode: 'CTR-0002' },
  { employmentId: 'e4', name: 'Rahman Bin Yusof', employeeCode: null },
];
const ids = (q: string, cap?: number) => matchEmployees(people, q, cap).map((p) => p.employmentId);

describe('lib/employee-search · matchEmployees', () => {
  it('matches a PARTIAL employee id', () => {
    expect(ids('0008')).toEqual(['e1']);
    expect(ids('EMP-00')).toEqual(['e1', 'e2']);
  });

  it('treats the separators in an Employee ID as noise, not data', () => {
    // Someone reading an ID off a payslip types what they see; someone typing from memory does not.
    expect(ids('emp0081')).toEqual(['e2']);
    expect(ids('emp 0081')).toEqual(['e2']);
    expect(ids('emp.0081')).toEqual(['e2']);
    expect(ids('emp_0081')).toEqual(['e2']);
  });

  it('matches a PARTIAL name, anywhere in it, case-insensitively', () => {
    expect(ids('rahman')).toEqual(['e4', 'e1']); // starts-with beats contains
    expect(ids('wei')).toEqual(['e3']);
    expect(ids('CHAN')).toEqual(['e3']);
  });

  it('ranks an exact employee id first, and keeps the caller order for ties', () => {
    expect(ids('EMP-0008')[0]).toBe('e1');
    expect(ids('a')).toEqual(['e1', 'e2', 'e3', 'e4']); // all match; input order preserved
  });

  it('ranks code-prefix above name-prefix above a substring hit', () => {
    // "ctr" is the code prefix of e3 only; nothing else can outrank it.
    expect(ids('ctr')).toEqual(['e3']);
    // "bala" starts a name (e2) and appears nowhere else.
    expect(ids('bala')).toEqual(['e2']);
  });

  it('shows nothing for an empty query, and caps the list', () => {
    expect(ids('')).toEqual([]);
    expect(ids('   ')).toEqual([]);
    expect(ids('a', 2)).toEqual(['e1', 'e2']);
  });

  it('an employee with no employee code is still findable by name and never crashes the code match', () => {
    expect(ids('yusof')).toEqual(['e4']);
    expect(ids('EMP')).not.toContain('e4');
  });

  it('defaults to the shared cap when the caller does not pass one', () => {
    expect(EMPLOYEE_SEARCH_RESULT_CAP).toBe(8);
    const many = Array.from({ length: 20 }, (_, i) => ({
      name: `Ali Number ${i}`,
      employeeCode: `EMP-${String(i).padStart(4, '0')}`,
    }));
    expect(matchEmployees(many, 'ali')).toHaveLength(EMPLOYEE_SEARCH_RESULT_CAP);
    expect(matchEmployees(many, 'ali', 3)).toHaveLength(3);
  });
});

describe('lib/employee-search · there is exactly ONE implementation of the rule', () => {
  it('the Personnel module re-exports this function rather than carrying a copy', () => {
    // Identity, not equivalence: a forked copy would pass every assertion above on the day it was forked.
    expect(personnelMatchEmployees).toBe(matchEmployees);
    expect(SWITCHER_RESULT_CAP).toBe(EMPLOYEE_SEARCH_RESULT_CAP);
  });
});


describe('Personnel search navigation URLs', () => {
  it('selection is a URL, and the open tab rides along', () => {
    expect(switcherHref('abc')).toBe('/admin/personnel/abc');
    expect(switcherHref('abc', 'payroll')).toBe('/admin/personnel/abc?tab=payroll');
    expect(switcherHref('a b/c', 'careerMovement')).toBe('/admin/personnel/a%20b%2Fc?tab=careerMovement');
  });
});
