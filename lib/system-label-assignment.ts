/** Import intent is resolved before any writer runs. Blank input never widens explicit company input. */
export type LabelCompany = {id:string;name:string;writable:boolean;archived:Date|null};
export type LabelAssignment = {companyId:string;companyIds:string[]|null;criteria:'global'|'companies'};
/** Board c074c6b8: `detail` names the exact check and `column` the template column it read; neither changes a rule. */
export type LabelAssignmentDetail='invalidCriteria'|'companyNotPermitted'|'globalWithCompanies'|'globalAdminRequired'|'noOwnerCompany'|'companyNotInCriteria'|'criteriaCompaniesRequired';
export type LabelAssignmentColumn='Company'|'Criteria'|'Criteria Companies';
export class LabelAssignmentError extends Error {
  constructor(readonly reason:'invalidCompany'|'invalidCriteria'|'invalidCriteriaCompany'|'globalAdminRequired'|'criteriaCompaniesRequired',message:string,readonly detail?:LabelAssignmentDetail,readonly column?:LabelAssignmentColumn){super(message);}
}
export function resolveLabelAssignment(values:Readonly<Partial<Record<string,string>>>,companies:readonly LabelCompany[],groupAdmin:boolean):LabelAssignment {
  const company=values.Company?.trim()??'',criteria=values.Criteria?.trim().toLowerCase()??'',shared=values['Criteria Companies']?.trim()??'';
  if(criteria&&!['global','companies'].includes(criteria))throw new LabelAssignmentError('invalidCriteria','Criteria must be global or companies.','invalidCriteria','Criteria');
  const resolve=(value:string,column:LabelAssignmentColumn)=>{
    const matches=companies.filter(c=>c.id===value||c.name===value);
    if(matches.length!==1||!matches[0].writable||matches[0].archived)throw new LabelAssignmentError('invalidCompany','Company is unknown, ambiguous, inactive or outside your administrator scope.','companyNotPermitted',column);
    return matches[0].id;
  };
  const origin=company?resolve(company,'Company'):null;
  const ids=[...new Set(shared.split(';').map(v=>v.trim()).filter(Boolean).map(value=>resolve(value,'Criteria Companies')))].sort();
  const global=criteria==='global'||!criteria&&!company&&!shared;
  if(global){
    if(company||shared)throw new LabelAssignmentError('invalidCriteriaCompany','Global criteria must leave Company and Criteria Companies blank.','globalWithCompanies',company?'Company':'Criteria Companies');
    if(!groupAdmin)throw new LabelAssignmentError('globalAdminRequired','Global labels require a group administrator.','globalAdminRequired','Criteria');
    const owner=companies.filter(c=>c.writable&&!c.archived).map(c=>c.id).sort()[0];
    if(!owner)throw new LabelAssignmentError('invalidCompany','An active permitted company is required to own the label.','noOwnerCompany','Company');
    return {companyId:owner,companyIds:null,criteria:'global'};
  }
  if(origin&&ids.length&&!ids.includes(origin))throw new LabelAssignmentError('invalidCriteriaCompany','Company must be included in Criteria Companies.','companyNotInCriteria','Company');
  if(!ids.length&&origin)ids.push(origin);
  if(!ids.length)throw new LabelAssignmentError('criteriaCompaniesRequired','Choose at least one company for companies criteria.','criteriaCompaniesRequired','Criteria Companies');
  return {companyId:origin??ids[0],companyIds:ids,criteria:'companies'};
}

/** Historical records remain readable; new choices require one authorized operation company. */
export function labelAppliesToCompany(companyIds:readonly string[]|null|undefined,companyId?:string|null):boolean {
  return companyIds==null||!!companyId&&companyIds.includes(companyId);
}
