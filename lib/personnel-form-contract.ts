import { ATTENDANCE_PHOTO_SETTINGS,ATTENDANCE_PHOTO_LABEL_KEYS } from './attendance-photo-setting';
import { EMERGENCY_CONTACT_PRIORITIES } from './emergency-contact-vocabulary';
import { PAYMENT_METHODS } from './payment-methods';
/** Client-safe Personnel form presentation. Domain owners retain authorization and cross-field rules. */
import { personnelField, type PersonnelFieldDescriptor } from './personnel-field-registry';
import { personnelFieldChoices, personnelFieldLabel, personnelScalarIssue, type PersonnelLabelResolver } from './personnel-import-contract';
export type PersonnelFormContext={localIdentity?:boolean;passportTrio?:boolean;payRate?:boolean;activeTaxSelection?:boolean;noBasicSalary?:boolean;manualEmployeeCode?:boolean;selectCompany?:boolean};
export type PersonnelFormMode = 'create' | 'edit' | 'draft' | 'record';
export function personnelFormField(id:string):PersonnelFieldDescriptor {
  const field=personnelField(id);
  if(!field || !field.form)throw new Error(`Personnel form binding is missing: ${id}`);
  const issue=personnelFormMetadataIssue(field);if(issue)throw new Error(issue);
  return field;
}
export function personnelFormLabel(id:string,resolve:PersonnelLabelResolver) {
  return personnelFieldLabel(personnelFormField(id),resolve);
}
export function personnelFormRequired(id:string,mode:PersonnelFormMode='edit',context:PersonnelFormContext={}) {
  const field=personnelFormField(id);
  const base=mode==='create'||mode==='draft' ? field.import.requiredCreate : field.form!.required?.[mode] ?? false;
  return base || (field.form!.requiredOwner ? context[field.form!.requiredOwner] ?? false : false);
}
/** Draft controls deliberately have no name: that screen submits its JSON draft, never FormData. */
export function personnelControl(id:string,mode:PersonnelFormMode='edit',context:PersonnelFormContext={}) {
  const field=personnelFormField(id);
  return { 'data-personnel-field':id, ...(mode==='draft' ? {} : field.form!.name ? {name:field.form!.name} : {}), required:mode==='draft' ? false : personnelFormRequired(id,mode,context) };
}
export function personnelInput(id:string,mode:PersonnelFormMode='edit',context:PersonnelFormContext={}) {
  const field=personnelFormField(id);const widget=personnelFormWidget(id);
  if(!widget || !['text','email','date','month','number','checkbox','file'].includes(widget))throw new Error(`Personnel field needs its specialized renderer: ${id}`);
  return {...personnelControl(id,mode,context),type:widget, ...(field.form!.min==null?{}:{min:field.form!.min}), ...(field.form!.step==null?{}:{step:field.form!.step})};
}
export function personnelFormChoices(id:string) {
  const field=personnelFormField(id);
  if(field.allowedValuesOwner==='attendance.photoSetting')return ATTENDANCE_PHOTO_SETTINGS.map(value=>({value,labelKey:ATTENDANCE_PHOTO_LABEL_KEYS[value]}));
  if(field.allowedValuesOwner==='employment.paymentMethod')return PAYMENT_METHODS.map(value=>({value,labelKey:`people.detail.paymentMethod_${value}`}));
  if(field.allowedValuesOwner==='emergency.priority')return EMERGENCY_CONTACT_PRIORITIES.map(value=>({value,labelKey:`people.detail.emergency.${{primary:'priorityPrimary',secondary:'prioritySecondary',other:'priorityOther'}[value]}`}));
  return personnelFieldChoices(field);
}
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

export function personnelFormWidget(id:string) {
  const field=personnelFormField(id);
  return field.form!.widget ?? ({text:'text',date:'date',number:'number',currency:'number',boolean:'checkbox',choice:'choice',file:'file',status:'display'} as const)[field.type];
}

export function personnelFormMetadataIssue(field:PersonnelFieldDescriptor):string|null {
  const widget=field.form?.widget;
  const expected=({text:'text',date:'date',number:'number',currency:'number',boolean:'checkbox',choice:'choice',file:'file',status:'display'} as const)[field.type];
  if(widget && widget!=='display' && widget!==expected && !(widget==='email'&&field.type==='text') && !(widget==='month'&&field.type==='date'))return `Personnel widget contradicts canonical type: ${field.id}`;
  if(widget==='display'&&!field.form?.workflowReason)return `Personnel display field needs its derived/owner reason: ${field.id}`;
  if(field.form?.required?.create!=null||field.form?.required?.draft!=null)return `Personnel create requirement has a duplicate authority: ${field.id}`;
  return null;
}

/** Presentation and transport adapters never acquire a writable name accidentally. */
export function personnelDisplay(id:string) {personnelFormField(id);return {'data-personnel-field':id};}
export function personnelCarry(id:string) {return {...personnelDisplay(id),name:personnelFormName(id),type:'hidden'};}
export function personnelPresence(id:string) {return {...personnelDisplay(id),name:personnelFormName(id)+'__present',type:'hidden'};}
export function personnelRadio(id:string,mode:PersonnelFormMode='edit') {return {...personnelControl(id,mode),type:'radio'};}

export function personnelOwnedChoices<T>(id:string,owner:string,choices:readonly T[]) {
  if(personnelFormField(id).allowedValuesOwner!==owner)throw new Error(`Personnel choice owner does not match its descriptor: ${id}`);
  return choices;
}
