import { describe, expect, it } from 'vitest';
import { epf, epfContribution, statutory } from '../localization/my/payroll';

const manual = { mode: 'manual_percentage', employeeRate: 0.11, employerRate: 0.04 } as const;
const semiAuto = { mode: 'voluntary_excess', employeeRate: 0.11, employerRate: null } as const;

describe('EPF entered percentage', () => {
  it.each([
    [4999.99, 5000, 20, 550, 200],
    [5000, 5000, 20, 550, 200],
    [5000.01, 5100, 100, 561, 204],
    [11530.79, 11600, 100, 1276, 464],
    [19999.99, 20000, 100, 2200, 800],
    [20000, 20000, 100, 2200, 800],
    [20000.01, 20001, 1, 2201, 801],
    [20001, 20001, 1, 2201, 801],
  ])('rounds manual wages of RM%s before applying the rates', (wage, roundedWage, increment, employee, employer) => {
    expect(epf(wage, 0, undefined, manual)).toEqual({ employee, employer });
    expect(statutory(wage, undefined, 0, 0, undefined, { epfElection: manual })).toMatchObject({
      epfEmployee: employee, epfEmployer: employer,
      epfWorking: {
        actualWage: wage, roundedWage, increment,
        employee: { method: 'entered_rate', rate: 0.11, amount: employee },
        employer: { method: 'entered_rate', rate: 0.04, amount: employer },
      },
    });
  });

  it('uses the Part E published row on the actual combined wage', () => {
    expect(statutory(10000, undefined, 1530.79, 0, undefined, {
      epfElection: semiAuto, epfAge: 64, epfCitizenship: 'citizen', epfWageMonth: '2025-10',
    })).toMatchObject({
      epfEmployee: 1276, epfEmployer: 464,
      epfWorking: {
        actualWage: 11530.79, roundedWage: 11600, scheduleEffectiveFrom: '2025-10-01',
        employer: { method: 'schedule_row', schedulePart: 'E', bandFrom: 11500.01, bandUpTo: 11600, amount: 464 },
      },
    });
    expect(epfContribution(10000, 1530.79, undefined, semiAuto, { age: 64, citizenship: 'citizen' }))
      .toEqual({ employee: 1276, employer: 464, employeeOnBonus: 176 });
  });

  it('uses the published Part C band and the exact Part F wage', () => {
    expect(epfContribution(3250, 0, undefined, semiAuto, { age: 60, citizenship: 'pr' }).employer).toBe(212);
    expect(epfContribution(11530.79, 0, undefined, semiAuto, { age: 60, citizenship: 'non_citizen', wageMonth: '2025-10' }).employer).toBe(231);
    expect(epfContribution(11530.79, 0, undefined, semiAuto, { age: 60, citizenship: 'non_citizen', wageMonth: '2025-09' }).employer).toBe(5);
    expect(epfContribution(11530.79, 0, undefined, semiAuto, { age: 75, citizenship: 'non_citizen' }).employer).toBe(0);
  });

  it('uses the official NIL and formula cases independently of employee wage rounding', () => {
    expect(epf(10, 0, undefined, semiAuto)).toEqual({ employee: 3, employer: 0 });
    expect(epf(5000, 0.01, undefined, semiAuto)).toEqual({ employee: 561, employer: 651 });
    expect(epfContribution(20025.01, 0, undefined, semiAuto, { age: 64, citizenship: 'citizen' }).employer).toBe(802);
    expect(epf(4000, 0, undefined, { ...semiAuto, employeeRate: 0 })).toEqual({ employee: 0, employer: 520 });
    expect(epf(4000, 0, undefined, { ...semiAuto, employeeRate: null })).toEqual(epf(4000));
  });
});
