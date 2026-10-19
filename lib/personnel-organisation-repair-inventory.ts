import {PersonnelImportLookup} from './personnel-import-lookup';
/** Offline, read-only classification. The caller must obtain an authorized scoped snapshot.
 * No database access and no correction writer: candidates require a separately audited course.
 * A missing UUID is never guessed from a text label; valid references are never rewritten. */
export type OrganisationInventoryChoice={id:string;tenantId:string;companyIds:readonly string[];active:boolean;code?:string|null;label?:string|null};
export function personnelOrganisationRepairInventory(
 scope:{tenantId:string;companyIds:readonly string[]},
 rows:readonly {assignmentId:string;tenantId:string;companyId:string;reference:string|null}[],
 choices:readonly OrganisationInventoryChoice[],
) {
 const companies=new Set(scope.companyIds);
 return rows.filter(row=>row.tenantId===scope.tenantId && companies.has(row.companyId)).map(row=>{
  const available=choices.filter(choice=>choice.tenantId===scope.tenantId && choice.companyIds.includes(row.companyId));
  const exact=available.find(choice=>choice.id===row.reference);
  if(!row.reference)return {assignmentId:row.assignmentId,status:'blank' as const};
  if(exact)return {assignmentId:row.assignmentId,status:exact.active?'valid-reference' as const:'inactive-reference' as const};
  if(/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(row.reference))return {assignmentId:row.assignmentId,status:'missing-reference' as const};
  const lookup=new PersonnelImportLookup<string>('label-first');
  for(const choice of available.filter(choice=>choice.active))lookup.add(choice.id,choice.id,{codes:[choice.code],names:[choice.label]});
  const candidateId=lookup.get(row.reference);
  return {assignmentId:row.assignmentId,status:lookup.isAmbiguous(row.reference)?'ambiguous' as const:candidateId?'unique-text-candidate' as const:'unmatched' as const,...candidateId?{candidateId}:{}};
 });
}
