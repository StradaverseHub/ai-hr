/** Client-safe Personnel form presentation. Domain owners retain authorization and cross-field rules. */
import { personnelField, type PersonnelFieldDescriptor } from './personnel-field-registry';
import { personnelFieldChoices, personnelFieldLabel, personnelScalarIssue, type PersonnelLabelResolver } from './personnel-import-contract';
export type PersonnelFormMode = 'create' | 'edit' | 'draft' | 'record';
export function personnelFormField(id:string):PersonnelFieldDescriptor {
  const field=personnelField(id);
  if(!field || !field.form)throw new Error(`Personnel form binding is missing: ${id}`);
  return field;
}
export function personnelFormLabel(id:string,resolve:PersonnelLabelResolver) {
  return personnelFieldLabel(personnelFormField(id),resolve);
}
export function personnelFormRequired(id:string,mode:PersonnelFormMode='edit') {
  return personnelFormField(id).form!.required?.[mode] ?? false;
}
/** Draft controls deliberately have no name: that screen submits its JSON draft, never FormData. */
export function personnelControl(id:string,mode:PersonnelFormMode='edit') {
  const field=personnelFormField(id);
  return { 'data-personnel-field':id, ...(mode==='draft' ? {} : field.form!.name ? {name:field.form!.name} : {}), required:personnelFormRequired(id,mode) };
}
export function personnelInput(id:string,mode:PersonnelFormMode='edit') {
  const field=personnelFormField(id);const widget=field.form!.widget;
  if(!widget || !['text','email','date','month','number','checkbox','file'].includes(widget))throw new Error(`Personnel field needs its specialized renderer: ${id}`);
  return {...personnelControl(id,mode),type:widget, ...(field.form!.min==null?{}:{min:field.form!.min}), ...(field.form!.step==null?{}:{step:field.form!.step})};
}
export function personnelFormChoices(id:string) { return personnelFieldChoices(personnelFormField(id)); }
export function personnelFormIssue(id:string,value:string,mode:PersonnelFormMode='edit') {
  const field=personnelFormField(id);
  if(!value.trim() && personnelFormRequired(id,mode))return 'required';
  return personnelScalarIssue(field,value);
}

export function personnelFormName(id:string,expected?:string) {
  const name=personnelFormField(id).form!.name;
  if(!name || (expected!=null && expected!==name))throw new Error(`Personnel form name does not match its binding: ${id}`);
  return name;
}

/** Catalog contents stay caller-scoped and fresh; the descriptor selects the canonical catalog owner. */
export function personnelFormCatalog<T>(id:string,catalogs:Record<string,T[]>) {
  const owner=personnelFormField(id).allowedValuesOwner;
  if(!owner?.startsWith('profile_option:'))throw new Error(`Personnel field has no profile catalog owner: ${id}`);
  const key=owner.slice('profile_option:'.length);
  if(!Object.prototype.hasOwnProperty.call(catalogs,key))throw new Error(`Personnel catalog is missing: ${owner}`);
  return catalogs[key];
}
