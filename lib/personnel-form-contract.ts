/** Client-safe Personnel form presentation. Domain owners retain authorization and cross-field rules. */
import { personnelField, type PersonnelFieldDescriptor } from './personnel-field-registry';
import { personnelFieldChoices, personnelFieldLabel, personnelScalarIssue, type PersonnelLabelResolver } from './personnel-import-contract';
import { isCalendarDate } from './calendar-date';
export type PersonnelFormContext={localIdentity?:boolean;passportTrio?:boolean;payRate?:boolean;activeTaxSelection?:boolean;noBasicSalary?:boolean;manualEmployeeCode?:boolean;selectCompany?:boolean;movementEndDate?:boolean;epfManualPercentage?:boolean;employmentStartDate?:string;calendarAssignmentStartDate?:string};
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
  return personnelInputPresentation(id,personnelFormWidget(id),mode,context);
}
/** Both ordinary and workflow inputs use the same scalar presentation owner. */
function personnelInputPresentation(id:string,widget:ReturnType<typeof personnelFormWidget>,mode:PersonnelFormMode,context:PersonnelFormContext) {
  const field=personnelFormField(id);
  if(!widget || !['text','email','date','month','number','checkbox','file'].includes(widget))throw new Error(`Personnel field needs its specialized renderer: ${id}`);
  const minimum=field.form!.minOwner?context[field.form!.minOwner]:field.form!.min;
  if(field.form!.minOwner&&(typeof minimum!=='string'||!isCalendarDate(minimum)))throw new Error(`Personnel date minimum context is missing or invalid: ${id}`);
  return {...personnelControl(id,mode,context),type:widget, ...(minimum==null?{}:{min:minimum}), ...(field.form!.max==null?{}:{max:field.form!.max}), ...(field.form!.step==null?{}:{step:field.form!.step})};
}
export function personnelFormChoices(id:string) {
  return personnelFieldChoices(personnelFormField(id));
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
  if(widget && widget!=='display' && widget!==expected && !(widget==='email'&&field.type==='text') && !(widget==='month'&&field.type==='date') && !(widget==='choice'&&field.type==='boolean'))return `Personnel widget contradicts canonical type: ${field.id}`;
  if(widget==='display'&&!field.form?.workflowReason)return `Personnel display field needs its derived/owner reason: ${field.id}`;
  if(field.form?.required?.create!=null||field.form?.required?.draft!=null)return `Personnel create requirement has a duplicate authority: ${field.id}`;
  if(field.form?.minOwner&&(field.type!=='date'||widget&&widget!=='date'||field.form.min!=null))return `Personnel date minimum contradicts canonical metadata: ${field.id}`;
  for(const [workflow,workflowWidget] of Object.entries(field.form?.workflowWidgets??{})){
    if(!workflowWidget||!field.form?.workflowNames||!Object.hasOwn(field.form.workflowNames,workflow))return `Personnel workflow widget lacks an owning binding: ${field.id}`;
    const issue=personnelFormMetadataIssue({...field,form:{...field.form,widget:workflowWidget,workflowWidgets:undefined}});
    if(issue)return issue;
  }
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

/** A dedicated workflow may submit the same fact under its own explicitly declared action name. */
export function personnelWorkflowControl(id:string,workflow:'movement'|'hireCorrection'|'companyCorrection'|'delegationEnd'|'informationCorrection',mode:PersonnelFormMode='edit',context:PersonnelFormContext={}) {
  const name=personnelFormField(id).form!.workflowNames?.[workflow];
  if(!name)throw new Error(`Personnel workflow binding is missing: ${workflow}:${id}`);
  return {...personnelControl(id,mode,context),name};
}
export function personnelWorkflowInput(id:string,workflow:'movement'|'hireCorrection'|'companyCorrection'|'delegationEnd'|'informationCorrection',mode:PersonnelFormMode='edit',context:PersonnelFormContext={}) {
  const widget=personnelFormField(id).form!.workflowWidgets?.[workflow]??personnelFormWidget(id);
  return {...personnelInputPresentation(id,widget,mode,context),...personnelWorkflowControl(id,workflow,mode,context)};
}

export function personnelWorkflowCarry(id:string,workflow:'movement'|'hireCorrection'|'companyCorrection'|'delegationEnd'|'informationCorrection') {
  return {...personnelWorkflowControl(id,workflow),type:'hidden',required:false};
}

/** ESS is an explicit authority presentation, unrelated to import/report/scope metadata. */
export function personnelEssControl(id:string,editable:ReadonlySet<string>,editing:boolean){
  const field=personnelField(id);if(!field||field.ess.visibility!=='visible')throw new Error('Personnel ESS binding unavailable.');
  return {'data-personnel-field':id,disabled:!editing||!editable.has(id)||!field.ess.binding||!['immediate','approval'].includes(field.ess.edit)};
}
