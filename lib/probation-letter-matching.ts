import type {ProbationTemplate} from './probation-workflow';
import {probationOrganisationMapping} from './probation-organisation';
export const LETTER_MAPPING_FIELDS=['businessGroup','businessUnit','company','department','grade'] as const;
export type LetterMappingField=typeof LETTER_MAPPING_FIELDS[number];
export type LetterTargetField='businessGroup'|'company'|'department'|'grade';
export type LetterOrganisationMigration={sourceVersionId:string|null;sourceVersion:number;reviewed:true;mappings:{sourceField:LetterMappingField;sourceValue:string;targetField:LetterTargetField;targetValues:string[]}[]};
export type LetterBuilderChoice={id:string;code:string;name:string;archived:boolean};
export type LetterBuilderCatalog={companyId:string;parentCompanyId:string;targets:Record<LetterTargetField,LetterBuilderChoice[]>;positions:LetterBuilderChoice[]};
export function letterMappingTarget(field:LetterMappingField,mapping:'legacy-v1'|'personnel-v2'):LetterTargetField{
 if(field==='businessGroup')return mapping==='legacy-v1'?'company':'businessGroup';
 if(field==='businessUnit')return mapping==='legacy-v1'?'businessGroup':'company';
 return field;
}
/** Rebuild an explicitly reviewed draft, never a stored version. Intersect collapsed conditions; never broaden them by union. */
export function applyReviewedLetterOrganisation(template:ProbationTemplate,companyId:string,migration:LetterOrganisationMigration):ProbationTemplate{
 const sourceMapping=probationOrganisationMapping(template);
 const expected=LETTER_MAPPING_FIELDS.flatMap(sourceField=>[...new Set(template.rules[sourceField]??[])].map(sourceValue=>({sourceField,sourceValue})));
 if(expected.length!==migration.mappings.length||expected.some(row=>migration.mappings.filter(mapping=>mapping.sourceField===row.sourceField&&mapping.sourceValue===row.sourceValue).length!==1))throw new Error('Review every saved matching value exactly once.');
 const grouped=new Map<LetterTargetField,Map<string,Set<string>>>();
 const add=(target:LetterTargetField,source:string,values:string[])=>{const groups=grouped.get(target)??new Map<string,Set<string>>(),set=groups.get(source)??new Set<string>();for(const value of values)set.add(value);groups.set(source,set);grouped.set(target,groups);};
 add('company','templateCompany',[companyId]);
 for(const row of migration.mappings){
  if(row.targetField!==letterMappingTarget(row.sourceField,sourceMapping)||!row.targetValues.length||new Set(row.targetValues).size!==row.targetValues.length)throw new Error('Choose complete canonical matches without changing identity kinds.');
  add(row.targetField,row.sourceField,row.targetValues);
 }
 const rules={...template.rules};for(const field of LETTER_MAPPING_FIELDS)delete rules[field];
 for(const [field,groups]of grouped){const sets=[...groups.values()],values=[...sets[0]].filter(value=>sets.every(set=>set.has(value))).sort();if(!values.length)throw new Error('The reviewed conditions have no shared match. Keep the published template until the mapping is corrected.');rules[field]=values;}
 return{...structuredClone(template),rules,organisationMapping:'personnel-v2',organisationMigration:structuredClone(migration)};
}
