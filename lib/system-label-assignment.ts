/** Import intent is resolved before any writer runs. Blank input never widens explicit company input. */
export type LabelCompany = {id:string;name:string;writable:boolean;archived:Date|null};
export type LabelAssignment = {companyId:string;companyIds:string[]|null;criteria:'global'|'companies'};
export class LabelAssignmentError extends Error {
  constructor(readonly reason:'invalidCompany'|'invalidCriteria'|'invalidCriteriaCompany'|'globalAdminRequired'|'criteriaCompaniesRequired',message:string){super(message);}
}
export function resolveLabelAssignment(values:Record<string,string>,companies:readonly LabelCompany[],groupAdmin:boolean):LabelAssignment {
  const company=values.Company?.trim()??'',criteria=values.Criteria?.trim().toLowerCase()??'',shared=values['Criteria Companies']?.trim()??'';
  if(criteria&&!['global','companies'].includes(criteria))throw new LabelAssignmentError('invalidCriteria','Criteria must be global or companies.');
  const resolve=(value:string)=>{
    const matches=companies.filter(c=>c.id===value||c.name===value);
    if(matches.length!==1||!matches[0].writable||matches[0].archived)throw new LabelAssignmentError('invalidCompany','Company is unknown, ambiguous, inactive or outside your administrator scope.');
    return matches[0].id;
  };
  const origin=company?resolve(company):null;
  const ids=[...new Set(shared.split(';').map(v=>v.trim()).filter(Boolean).map(resolve))].sort();
  const global=criteria==='global'||!criteria&&!company&&!shared;
  if(global){
    if(company||shared)throw new LabelAssignmentError('invalidCriteriaCompany','Global criteria must leave Company and Criteria Companies blank.');
    if(!groupAdmin)throw new LabelAssignmentError('globalAdminRequired','Global labels require a group administrator.');
    const owner=companies.filter(c=>c.writable&&!c.archived).map(c=>c.id).sort()[0];
    if(!owner)throw new LabelAssignmentError('invalidCompany','An active permitted company is required to own the label.');
    return {companyId:owner,companyIds:null,criteria:'global'};
  }
  if(origin&&ids.length&&!ids.includes(origin))throw new LabelAssignmentError('invalidCriteriaCompany','Company must be included in Criteria Companies.');
  if(!ids.length&&origin)ids.push(origin);
  if(!ids.length)throw new LabelAssignmentError('criteriaCompaniesRequired','Choose at least one company for companies criteria.');
  return {companyId:origin??ids[0],companyIds:ids,criteria:'companies'};
}

/** Historical records remain readable; new choices require one authorized operation company. */
export function labelAppliesToCompany(companyIds:readonly string[]|null|undefined,companyId?:string|null):boolean {
  return companyIds==null||!!companyId&&companyIds.includes(companyId);
}
