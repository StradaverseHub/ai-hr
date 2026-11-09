import 'server-only';

import type { SessionContext, Tx } from '../db/client';
import { defaultMasterColumn, runEmployeeMasterProjection, type EmployeeMasterSpec, type MasterCell } from '../lib/employee-master-report';
import type { PersonnelFieldDescriptor } from '../lib/personnel-field-registry';
import { MasterReportAccessError, masterReportFieldsTx } from './employee-master-access';
import { employeeMasterSubjectsTx } from './employee-master-projection';
import { withPersonnelRead } from './personnel-read-bounds';

const DETAILS_BATCH_SIZE = 1000;
const MAX_DETAIL_CELLS = 500_000;
const detailTabs = new Set(['Profile', 'Employment', 'Bank & Statutory', 'Payroll']);

export class PersonnelExportSizeError extends Error {}

export async function readPersonnelListExportDetails(
  ctx: SessionContext,
  rows: readonly { employmentId: string; companyId: string }[],
  today: string,
  existingTx: Tx,
): Promise<{ fields: PersonnelFieldDescriptor[]; cells: Map<string, MasterCell[]> }> {
  const companyIds = [...new Set(rows.map(row => row.companyId))];
  const cells = new Map<string, MasterCell[]>();
  if (!companyIds.length) return { fields: [], cells };

  return withPersonnelRead(ctx, async tx => {
    let catalogue: PersonnelFieldDescriptor[];
    try {
      catalogue = await masterReportFieldsTx(tx, ctx, companyIds);
    } catch (error) {
      if (error instanceof MasterReportAccessError) return { fields: [], cells };
      throw error;
    }
    const fields = catalogue.filter(field => field.report.enabled && field.grain === 'single' &&
      field.scope !== 'draft' && detailTabs.has(field.tab) && field.sensitivity !== 'documents');
    if (!fields.length) return { fields, cells };
    if (rows.length * fields.length > MAX_DETAIL_CELLS) throw new PersonnelExportSizeError();

    const spec: EmployeeMasterSpec = {
      v: 2, asAt: today, companyIds, includeDrafts: false,
      columns: fields.map(defaultMasterColumn),
      expression: { id: 'root', type: 'group', logic: 'and', children: [] },
      sorts: [], groups: [],
      pdf: { paper: 'A4', orientation: 'portrait', margins: 'normal', logo: false, pageBreakGroups: false },
    };
    for (let offset = 0; offset < rows.length; offset += DETAILS_BATCH_SIZE) {
      const employmentIds = rows.slice(offset, offset + DETAILS_BATCH_SIZE).map(row => row.employmentId);
      const subjects = await employeeMasterSubjectsTx(tx, ctx, spec, fields, catalogue, { employmentIds });
      const projection = runEmployeeMasterProjection(spec, fields, subjects, today);
      for (const row of projection.sections[0]?.rows ?? []) cells.set(row.subjectId, row.cells);
    }
    return { fields, cells };
  }, { existingTx });
}
