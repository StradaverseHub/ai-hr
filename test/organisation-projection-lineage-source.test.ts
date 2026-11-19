import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {getTableColumns} from 'drizzle-orm';
import {expect,it} from 'vitest';
import {assignment} from '../db/schema';
import {ASSIGNMENT_PROJECTION_IMAGE_KEYS} from '../lib/assignment-projection-image';
import {OrganisationProjectionLineageError} from '../core/organisation-projection-lineage';
import {isTransientBulkJobError} from '../core/bulk-job-worker';

it('covers every persisted Assignment field except its later supersession marker',()=>{
 expect([...ASSIGNMENT_PROJECTION_IMAGE_KEYS].sort()).toEqual(Object.keys(getTableColumns(assignment)).filter(key=>key!=='supersededAt').sort());
});
it('retains the actual pre-proposal native body in its legacy-population fixture',()=>{
 const source=readFileSync(new URL('./fixtures/legacy-org-projection-owner.ts',import.meta.url),'utf8');
 const start=source.indexOf('export async function projectEmploymentOrganisationAssignmentTx('),end=source.indexOf('\n}',start)+2;
 expect(start).toBeGreaterThan(0);expect(end).toBeGreaterThan(start);
 expect(createHash('sha256').update(source.slice(start,end)).digest('hex')).toBe('045ac99e9e712e2db9efc6814f4a15332ef1e1caa7f216a28719a73994dbdfc7');
});
it('classifies an unprovable native projection as reconciliation, not a transient retry',()=>{
 const error=new OrganisationProjectionLineageError();
 expect(isTransientBulkJobError(error)).toBe(false);
 expect(error.message).toContain('reconcile');
});
it('keeps passive Org evidence outside the original native Movement business-event allowlist',()=>{
 const source=readFileSync(new URL('../core/movement.ts',import.meta.url),'utf8');
 const start=source.indexOf('const MOVEMENT_EVENT_TYPES = ['),end=source.indexOf('\n];',start)+3;
 expect(start).toBeGreaterThan(0);expect(end).toBeGreaterThan(start);
 const list=source.slice(start,end);
 const historyRevision='  MOVEMENT_HISTORY_EDITED_EVENT,\n';
 expect(list.split(historyRevision)).toHaveLength(2);
 expect(createHash('sha256').update(list.replace(historyRevision,'')).digest('hex')).toBe('519fd1a3e19ac1940d31514b44406e754e5323cb77f14fc73323a323a3351d07');
});
