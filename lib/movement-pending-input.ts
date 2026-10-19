/** Client-safe names of saved scheduling inputs; absence stays distinct from an explicit clear. */
export const MOVEMENT_PENDING_COMPARISON_FIELDS = [
  'companyId','departmentId','positionId','businessUnitId','locationId','gradeId',
  'employmentType','managerEmploymentId','basicSalary','currency','payMode','paymentTerm',
  'orgDivision','employmentCategory','orgRegion','orgBranch','orgTeam','orgSection','orgLine','orgBase',
] as const;
export const MOVEMENT_PENDING_INPUT_FIELDS = [...MOVEMENT_PENDING_COMPARISON_FIELDS,
  'terminationReasonCode','terminationNoticeDays','resignationDate',
] as const;
export type MovementPendingFormValues = Partial<Record<typeof MOVEMENT_PENDING_INPUT_FIELDS[number],string|null>>;
/** A presentation projection of explicitly recorded scalar values, never current/default facts. */
export function movementPendingFormValues(raw:unknown):MovementPendingFormValues {
  const values:MovementPendingFormValues={};
  if(!raw||typeof raw!=='object'||Array.isArray(raw))return values;
  for(const key of MOVEMENT_PENDING_INPUT_FIELDS){
    if(!Object.prototype.hasOwnProperty.call(raw,key))continue;
    const value:unknown=Reflect.get(raw,key);
    if(value===null||typeof value==='string'||typeof value==='number'&&Number.isFinite(value))values[key]=value===null?null:String(value);
  }
  return values;
}
