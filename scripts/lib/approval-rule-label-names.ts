/** Names of the organisation codes an approval rule can name, for the unreachable-rules report. The report reads
 * them on the storage-owner connection, which row security does not govern, so codes still staged by a running
 * System Labels import (migration 9961) are filtered explicitly (core/system-label-visibility.ts). */
import {and,eq} from 'drizzle-orm';
import type {Db} from '../../db/client';
import {businessUnit,department,gradeGroup,jobGrade,position} from '../../db/schema';
import {releasedLabelRows} from '../../core/system-label-visibility';

export type ApprovalRuleLabelNames=Record<'businessUnitId'|'departmentId'|'positionId'|'gradeId'|'gradeGroupId',Map<string,string>>;
// Explicit per table rather than a generic helper: the label column is NOT uniform — position uses `title` (its
// `name` does not exist) while the others use `name`, and a union of table types loses the common column anyway.
const idName=(rows:{id:string;name:string}[])=>new Map(rows.map(r=>[r.id,r.name]));
export async function approvalRuleLabelNames(db:Db,tenantId:string):Promise<ApprovalRuleLabelNames>{
 return{
  businessUnitId:idName(await db.select({id:businessUnit.id,name:businessUnit.name}).from(businessUnit).where(and(eq(businessUnit.tenantId,tenantId),releasedLabelRows(businessUnit)))),
  departmentId:idName(await db.select({id:department.id,name:department.name}).from(department).where(and(eq(department.tenantId,tenantId),releasedLabelRows(department)))),
  positionId:idName(await db.select({id:position.id,name:position.title}).from(position).where(and(eq(position.tenantId,tenantId),releasedLabelRows(position)))),
  gradeId:idName(await db.select({id:jobGrade.id,name:jobGrade.name}).from(jobGrade).where(and(eq(jobGrade.tenantId,tenantId),releasedLabelRows(jobGrade)))),
  gradeGroupId:idName(await db.select({id:gradeGroup.id,name:gradeGroup.name}).from(gradeGroup).where(and(eq(gradeGroup.tenantId,tenantId),releasedLabelRows(gradeGroup)))),
 };
}
