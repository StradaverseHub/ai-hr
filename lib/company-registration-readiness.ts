export type CompanyRegistrationStatus='complete'|'missing'|'not_required';
export type CompanyRegistrationClassification={entityKind:'legal_entity'|'grouping_node';isTestEntity:boolean;revision:number};
export type CompanyRegistrationReadiness={id:string;status:CompanyRegistrationStatus;missing:string[];levyUnavailable:boolean;activeEmployees:number;counted:boolean;classification:CompanyRegistrationClassification};
export function companyRegistrationResult(input:{id:string;archived:boolean;classification:CompanyRegistrationClassification;activeEmployees:number;readiness:{missing:readonly string[];levyUnavailable:boolean}}):CompanyRegistrationReadiness{
 const grouping=input.classification.entityKind==='grouping_node';return{id:input.id,status:grouping?'not_required':input.readiness.missing.length?'missing':'complete',missing:grouping?[]:[...input.readiness.missing],levyUnavailable:!grouping&&input.readiness.levyUnavailable,activeEmployees:input.activeEmployees,counted:!grouping&&!input.archived&&!input.classification.isTestEntity,classification:input.classification};
}
/** Tree ancestors are retained for navigation; every missing employer is counted once. */
export function registrationTreeState(nodes:readonly {id:string;parentId:string|null}[],readiness:ReadonlyMap<string,CompanyRegistrationReadiness>){
 const parentBy=new Map(nodes.map(n=>[n.id,n.parentId])),counts=new Map<string,number>(),visible=new Set<string>();
 for(const n of nodes){const r=readiness.get(n.id);if(!r?.counted||r.status!=='missing')continue;const seen=new Set<string>();let id:string|null=n.id;
  while(id&&parentBy.has(id)&&!seen.has(id)){seen.add(id);counts.set(id,(counts.get(id)??0)+1);visible.add(id);id=parentBy.get(id)??null;}
 }
 return {counts,visible};
}
