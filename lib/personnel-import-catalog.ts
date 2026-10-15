import {PERSONNEL_FIELDS} from './personnel-field-registry';
import {DEPENDENT_RELATIONSHIPS} from './dependent-vocabulary';
import {PersonnelImportLookup} from './personnel-import-lookup';
import type {PersonnelImportSheet} from './personnel-import-contract';
/** Same active owner values as the forms; display names are aliases, never stored instead of codes. */
export class PersonnelImportCatalog extends Map<string,Set<string>> {
 private lookups=new Map<string,PersonnelImportLookup<string>>();
 addOption(option:{category:string;value:string;label?:string|null}) {
  const values=this.get(option.category)??new Set<string>();values.add(option.value);this.set(option.category,values);
  const lookup=this.lookups.get(option.category)??new PersonnelImportLookup<string>();
  lookup.add(option.value,option.value,{names:[option.label]});this.lookups.set(option.category,lookup);
 }
 resolve(category:string,value:string) {const lookup=this.lookups.get(category);return {value:lookup?.get(value),ambiguous:lookup?.isAmbiguous(value)??false};}
}
export function normalizePersonnelCatalogRecord(record:Record<string,string>,sheet:PersonnelImportSheet,catalog:Map<string,Set<string>>) {
 const normalized={...record};const errors:string[]=[];
 if(!(catalog instanceof PersonnelImportCatalog))return {record:normalized,errors};
 const fields=PERSONNEL_FIELDS.filter(field=>field.import.column && (sheet==='family'?field.import.section==='family':field.import.section!=='family'));
 const columns=new Map(fields.filter(field=>field.import.catalog).map(field=>[field.import.column!,field.import.catalog!]));
 if(sheet==='family')columns.set('relationship','dependentRelationship');
 else columns.set('passport_issuing_country','nationality');
 for(const [column,category] of columns) {
  const raw=(record[column]??'').trim();if(!raw)continue;
  if(column==='relationship' && (DEPENDENT_RELATIONSHIPS as readonly string[]).includes(raw))continue;
  const found=catalog.resolve(category,raw);
  if(found.ambiguous)errors.push(`${column}: ambiguous option name — use its exact saved code from the Reference sheet.`);
  else if(found.value!==undefined)normalized[column]=found.value;
 }
 return {record:normalized,errors};
}
/** Display names are listed only when unambiguous; exact saved values remain available in every list. */
export function personnelCatalogReferenceValues(options:readonly {category:string;value:string;label?:string|null}[]) {
 const catalog=new PersonnelImportCatalog();for(const option of options)catalog.addOption(option);
 return [...new Set(options.flatMap(option=>[option.value,...option.label && catalog.resolve(option.category,option.label).value===option.value?[option.label]:[]]))];
}
