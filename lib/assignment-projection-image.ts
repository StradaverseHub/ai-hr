import type {assignment} from '../db/schema';
export const ASSIGNMENT_PROJECTION_IMAGE_KEYS=['id','tenantId','employmentId','positionId','departmentId','businessUnitId','costCenterId','locationId','companyId','employmentType','validFrom','validTo','recordedAt','createdAt'] as const;
export type AssignmentProjectionImage=Record<(typeof ASSIGNMENT_PROJECTION_IMAGE_KEYS)[number],string|null>;
/** All persisted Assignment columns except the later supersession marker. No caller-selected fields. */
export function assignmentProjectionImage(row:typeof assignment.$inferSelect):AssignmentProjectionImage{
 return Object.fromEntries(ASSIGNMENT_PROJECTION_IMAGE_KEYS.map(key=>[key,row[key] instanceof Date?(row[key] as Date).toISOString():row[key]])) as AssignmentProjectionImage;
}
