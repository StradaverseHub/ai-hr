'use server';

import { searchEmployeeOptions } from '@/core/employee-search';
import { scopedAdmin } from '@/lib/scope';
import type { SwitcherEmployee } from './employee-search';

/** Resolve permissions and the active company selection afresh for every search request. */
export async function searchPersonnelEmployeesAction(query: string): Promise<SwitcherEmployee[]> {
  const { s, scopeIds } = await scopedAdmin();
  if (typeof query !== 'string') return [];
  const rows = await searchEmployeeOptions(s, { companyIds: scopeIds, query });
  return rows.map(({ employmentId, name, employeeCode, company, department }) => ({
    employmentId, name, employeeCode, company, department,
  }));
}
