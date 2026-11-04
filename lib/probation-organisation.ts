/** Identity semantics pinned to each source/configuration version. Labels never change UUID types. */
export type ProbationOrganisationMapping='legacy-v1'|'personnel-v2';
export type ProbationOrganisationFacts={companyId:string;companyName?:string;businessGroupId:string|null;businessGroup?:string|null;businessUnitId:string|null;businessUnit?:string|null;organisationMapping?:ProbationOrganisationMapping;organisationLegacy?:{businessGroupId:string|null;businessGroup:string|null;businessUnitId:string|null;businessUnit:string|null}};
export const probationOrganisationMapping=(value:{organisationMapping?:ProbationOrganisationMapping}):ProbationOrganisationMapping=>value.organisationMapping??'legacy-v1';
/** Pure projection only: never rewrites historical case facts or signed-document merge snapshots. */
export function probationOrganisationFacts<T extends ProbationOrganisationFacts>(facts:T,mapping:ProbationOrganisationMapping):T{
 if(probationOrganisationMapping(facts)===mapping)return {...facts};
 if(mapping==='personnel-v2')return {...facts,organisationMapping:mapping,
  organisationLegacy:{businessGroupId:facts.businessGroupId,businessGroup:facts.businessGroup??null,businessUnitId:facts.businessUnitId,businessUnit:facts.businessUnit??null},
  businessGroupId:facts.businessUnitId,businessGroup:facts.businessUnit??null,businessUnitId:facts.companyId,businessUnit:facts.companyName??null};
 const legacy=facts.organisationLegacy;
 // The legacy parent-company identity cannot be inferred from a PM Business Unit UUID.
 return {...facts,organisationMapping:mapping,businessGroupId:legacy?.businessGroupId??null,businessGroup:legacy?.businessGroup??null,businessUnitId:legacy?.businessUnitId??facts.businessGroupId,businessUnit:legacy?.businessUnit??facts.businessGroup??null};
}
export type ProbationOrganisationCatalog={businessGroups:{id:string;name:string;companyId?:string}[];businessUnits:{id:string;name:string;companyId:string}[]};
export function probationOrganisationCatalog<T extends ProbationOrganisationCatalog&{organisationCatalogs?:Record<ProbationOrganisationMapping,ProbationOrganisationCatalog>}>(options:T,mapping:ProbationOrganisationMapping='legacy-v1'):T{
 return {...options,...options.organisationCatalogs?.[mapping]};
}
