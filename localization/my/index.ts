/**
 * Malaysia localization pack (ADR-0008). Slice 1 ships the statutory profile; leave rules,
 * holiday calendar, and payroll calculators (EPF/SOCSO/EIS/PCB) join here in later slices.
 */
import { getStatutoryProfileMY, isValidIC, setStatutoryProfileMY } from './statutory';
import { annualEntitlement, entitlement, MY_LEAVE_TYPES } from './leave';
import { MY_HOLIDAYS_2026 } from './holidays';
import { eis, epf, pcb, socso, statutory } from './payroll';
import { getCompanyStatutoryMY, setCompanyStatutoryMY } from './company-statutory';

export const myPack = {
  country: 'MY' as const,
  statutory: {
    set: setStatutoryProfileMY,
    get: getStatutoryProfileMY,
    validateIC: isValidIC,
  },
  companyStatutory: {
    set: setCompanyStatutoryMY,
    get: getCompanyStatutoryMY,
  },
  leave: {
    types: MY_LEAVE_TYPES,
    entitlement,
    annualEntitlement,
  },
  holidays: MY_HOLIDAYS_2026,
  payroll: { statutory, epf, socso, eis, pcb },
};
