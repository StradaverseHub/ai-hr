/** Localisation uses the same descriptor label owner without depending on a Next request in the renderer. */
import {personnelFieldLabel} from './personnel-field-label';
import type {PersonnelFieldDescriptor} from './personnel-field-registry';
const catalogues={en:()=>import('../messages/en.json'),ms:()=>import('../messages/ms.json'),zh:()=>import('../messages/zh.json'),vi:()=>import('../messages/vi.json'),ta:()=>import('../messages/ta.json'),th:()=>import('../messages/th.json')};
export async function employeeMasterFieldLabels(fields:readonly PersonnelFieldDescriptor[],locale:string):Promise<PersonnelFieldDescriptor[]>{
 const load=catalogues[locale as keyof typeof catalogues]??catalogues.en,all=(await load()).default;
 const resolve=(key:string,fallback:string):string=>{let value:unknown=all;for(const part of key.split('.')){if(!value||typeof value!=='object'||Array.isArray(value))return fallback;value=(value as Record<string,unknown>)[part];}return typeof value==='string'?value:fallback;};
 return fields.map(field=>({...field,label:personnelFieldLabel(field,resolve)}));
}
