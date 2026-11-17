const placement=new Set(['companyId','businessUnitId','departmentId','positionId','employmentType','locationId','managerEmploymentId','costAllocation']);
const contract=new Set(['employmentType','contractEndDate','internshipEndDate']);
/** Shared fields, and company/type changes whose validation depends on the other field's value. */
export function conflictingMovementFields(left:readonly string[],right:readonly string[]):string[]{
 const a=new Set(left),b=new Set(right),conflicts=new Set(left.filter(field=>b.has(field)));
 if(a.has('companyId')&&right.some(field=>placement.has(field))||b.has('companyId')&&left.some(field=>placement.has(field)))conflicts.add('companyId');
 if(a.has('employmentType')&&right.some(field=>contract.has(field))||b.has('employmentType')&&left.some(field=>contract.has(field)))conflicts.add('employmentType');
 return [...conflicts].sort();
}
