import {personnelField} from './personnel-field-registry';
import {WORKFORCE_PROFILE_FIELDS} from './workforce-record-fields';
export type WorkforceMaintenanceKind='person'|'qualification'|'emergency'|'dependent';
export type WorkforceMaintenanceOperation='add'|'update'|'archive';
export type WorkforceValue=string|boolean|number|null;
export const WORKFORCE_PROFILE_SECTIONS=[
 {key:'personal',title:'personalDetails',prefix:'profile.personal_details.'},
 {key:'contact',title:'contactAddressTitle',prefix:'profile.contact_and_permanent_address.'},
 {key:'correspondence',title:'correspondenceAddressTitle',prefix:'profile.correspondence_address.'},
] as const;
/** Explicit Workforce permission bindings, independent from ESS visibility/edit policy. Adding a
 * self-service field must not silently add a non-HR maintenance permission or a projected value. */
export const WORKFORCE_REGISTER_FIELDS={
 qualification:([['qualification','level'],['institute','institute'],['fromYm','fromym'],['toYm','toym'],['graduationDate','graduationdate'],['major','major'],['result','result'],['description','description'],['isHighest','highest']] as const).map(([key,id])=>({key,fieldId:'qualification.academic_and_professional_qualifications.'+id})),
 emergency:['fullName','relationship','mobilePhone','homePhone','address','priority'].map(key=>({key,fieldId:'profile.emergency_contact.'+key.toLowerCase()})),
 dependent:['relationship','fullName','gender','dateOfBirth','phone','icOrPassport','passportNumber','residentialAddress','marriageDate','marriageStatus','spouseWorking','isBeneficiary','isDeceased','isStudent','schoolName','studyLevel','studyCountry','childReliefCategory','childTaxRelief','childReliefPercentage'].map(key=>({key,fieldId:'family.family_and_dependents.'+key.toLowerCase()})),
} as const;
export function workforceMaintenanceFields(kind:WorkforceMaintenanceKind,section?:string){
 if(kind==='person'){
  const group=WORKFORCE_PROFILE_SECTIONS.find(item=>item.key===section);
  return WORKFORCE_PROFILE_FIELDS.filter(f=>!section||group&&f.fieldId.startsWith(group.prefix)).map(f=>({key:f.key as string,field:personnelField(f.fieldId)!}));
 }
 return WORKFORCE_REGISTER_FIELDS[kind].map(({key,fieldId})=>({key,field:personnelField(fieldId)!}));
}

/** The finite maintenance renderer preserves incomplete existing records while requiring the
 * descriptor's mandatory fields on new rows. Names and facts come from the same owner declaration;
 * the caller cannot bind an arbitrary field or borrow another register's key. */
export function workforceMaintenanceControl(fieldId:string,kind:WorkforceMaintenanceKind,key:string,existing:boolean,current:string){
 const binding=workforceMaintenanceFields(kind).find(item=>item.key===key);
 if(!binding||binding.field.id!==fieldId||binding.field.form?.name!==key)throw new Error('Workforce form binding unavailable');
 return {'data-personnel-field':fieldId,name:key,required:Boolean(binding.field.form.required?.record)&&((!existing&&kind!=='person')||current!=='')};
}

/** Scalar fallback for the bounded record editor; catalog choices keep their existing selected
 * renderer, and dates/months retain their descriptor widget. This changes no domain validation. */
export function workforceMaintenanceInput(fieldId:string,kind:WorkforceMaintenanceKind,key:string,existing:boolean,current:string){
 const control=workforceMaintenanceControl(fieldId,kind,key,existing,current),field=personnelField(fieldId)!;
 return {...control,type:field.form?.widget==='month'?'month':field.type==='date'?'date':'text',inputMode:field.form?.widget==='email'?'email' as const:undefined};
}
