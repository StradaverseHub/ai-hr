/**
 * Malaysia localization pack (ADR-0008). Slice 1 ships the statutory profile; leave rules,
 * holiday calendar, and payroll calculators (EPF/SOCSO/EIS/PCB) join here in later slices.
 */
import { getStatutoryProfileMY, isValidIC, setStatutoryProfileMY } from './statutory';

export const myPack = {
  country: 'MY' as const,
  statutory: {
    set: setStatutoryProfileMY,
    get: getStatutoryProfileMY,
    validateIC: isValidIC,
  },
};
