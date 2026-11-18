import {PERSONNEL_FIELDS} from './personnel-field-registry';
import {DEPENDENT_RELATIONSHIPS} from './dependent-vocabulary';
import {PersonnelImportLookup} from './personnel-import-lookup';
import {personnelImportFields,type PersonnelImportSheet} from './personnel-import-contract';
/** Same active owner values as the forms; display names are aliases, never stored instead of codes. */
export class PersonnelImportCatalog extends Map<string,Set<string>> {
 constructor(private readonly labelFirstCategories:ReadonlySet<string>=new Set()) {super();}
 private lookups=new Map<string,PersonnelImportLookup<string>>();
 private labels=new Map<string,Map<string,string>>();
 addOption(option:{category:string;value:string;label?:string|null;isActive?:boolean}) {
  const values=this.get(option.category)??new Set<string>();this.set(option.category,values);
  if(option.isActive===false)return;values.add(option.value);
  const labels=this.labels.get(option.category)??new Map<string,string>();labels.set(option.value,option.label?.trim()?`${option.label.trim()} (${option.value})`:option.value);this.labels.set(option.category,labels);
  const lookup=this.lookups.get(option.category)??new PersonnelImportLookup<string>(this.labelFirstCategories.has(option.category)?'label-first':'identifier-first');
  lookup.add(option.value,option.value,{names:[option.label]});this.lookups.set(option.category,lookup);
 }
 display(category:string,value:string) {return this.labels.get(category)?.get(value);}
 resolve(category:string,value:string) {const lookup=this.lookups.get(category);return {value:lookup?.get(value),ambiguous:lookup?.isAmbiguous(value)??false};}
}
export function normalizePersonnelCatalogRecord(record:Record<string,string>,sheet:PersonnelImportSheet,catalog:Map<string,Set<string>>) {
 const normalized={...record};const errors:string[]=[];
 if(!(catalog instanceof PersonnelImportCatalog))return {record:normalized,errors};
 const fields=personnelImportFields(sheet);
 const columns=new Map(fields.filter(field=>field.import.catalog).map(field=>[field.import.column!,field.import.catalog!]));
 if(sheet==='family')columns.set('relationship','dependentRelationship');
 else if(sheet==='employee')columns.set('passport_issuing_country','nationality');
 else if(sheet==='qualification')columns.set('qualification','qualificationLevel');
 else columns.set('relationship','relationship');
 for(const [column,category] of columns) {
  const raw=(record[column]??'').trim();if(!raw)continue;
  if(sheet==='family' && column==='relationship' && (DEPENDENT_RELATIONSHIPS as readonly string[]).includes(raw))continue;
  const found=catalog.resolve(category,raw);
  if(found.ambiguous)errors.push(`${column}: ambiguous option name — choose a distinct label or code from the Reference sheet.`);
  else if(found.value!==undefined)normalized[column]=found.value;
 }
 return {record:normalized,errors};
}
/** Excel list choices contain only the exact saved codes, including leading zeroes. Labels stay on Reference. */
export function personnelCatalogReferenceValues(options:readonly {category:string;value:string;label?:string|null}[]) {
 return [...new Set(options.filter(option=>option.value.trim()!=='').map(option=>option.value))];
}
