import 'server-only';

import type { SessionContext, Tx } from '../db/client';
import { defaultMasterColumn, runEmployeeMasterProjection, type EmployeeMasterSpec, type MasterCell } from '../lib/employee-master-report';
import type { PersonnelFieldDescriptor } from '../lib/personnel-field-registry';
import { MasterReportAccessError, masterReportFieldsTx } from './employee-master-access';
import { employeeMasterSubjectsTx } from './employee-master-projection';
import { withPersonnelPresentationReadTx } from './personnel-read-bounds';
import { withAccessDisplayRead } from './access-configuration-lock';

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

  // The export's employee-master projection reads every listed employment: an owner Workforce check inside joins the
  // Access lock shared instead of taking it exclusively for the export (staging, 11 November 2026). Without such a
  // field the snapshot still reads behind no Access writer.
  return withAccessDisplayRead(() => withPersonnelPresentationReadTx(ctx, existingTx, async (tx, current) => {
    let catalogue: PersonnelFieldDescriptor[];
    try {
      catalogue = await masterReportFieldsTx(tx, current, companyIds);
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
    // One set-wise subject read for every row, so the statements do not grow with the rows. It keeps the
    // bounds of the DETAILS_BATCH_SIZE slices this export used to read one call each (`bulk`), and each
    // slice is still projected on its own, in the same order, exactly as those calls projected it.
    const employmentIds = rows.map(row => row.employmentId);
    const subjects = await employeeMasterSubjectsTx(tx, current, spec, fields, catalogue, {
      employmentIds, bulk: { batchSize: DETAILS_BATCH_SIZE },
    });
    for (let offset = 0; offset < rows.length; offset += DETAILS_BATCH_SIZE) {
      if (offset) await new Promise<void>(resolve => setImmediate(resolve));
      const slice = new Set(employmentIds.slice(offset, offset + DETAILS_BATCH_SIZE));
      const projection = runEmployeeMasterProjection(spec, fields, subjects.filter(subject => slice.has(subject.id)), today);
      for (const row of projection.sections[0]?.rows ?? []) cells.set(row.subjectId, row.cells);
    }
    return { fields, cells };
  }));
}
