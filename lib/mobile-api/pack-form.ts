import {z} from 'zod';
import type {Tx} from '../../db/client';
import type {PackWorkspace,PackAction,PackBlock,PackField,PackValue} from './v2/pack-workspaces';
export type PreparedPackReview={view:Omit<PackWorkspace,'expected'|'today'|'kind'|'id'>;run:(tx:Tx,action:string,values:Record<string,PackValue>)=>Promise<string>};
export const textField=(key:string,label:string,value:PackValue='',required=false):PackField=>({key,label,kind:'text',value,required});
export const choiceField=(key:string,label:string,options:readonly string[],value:PackValue=null,required=true):PackField=>({key,label,kind:'choice',value,required,options:options.map(v=>({value:v,label:v}))});
export const numberField=(key:string,label:string,value:PackValue=null,required=true):PackField=>({key,label,kind:'number',value,required});
export const boolField=(key:string,label:string,required=false,value=false):PackField=>({key,label,kind:'boolean',value,required});
export const block=(id:string,title:string,rows:[string,unknown][]):PackBlock=>({id,title,rows:rows.map(([label,v])=>({label,value:v==null||v===''?'—':String(v)}))});
export const action=(id:string,label:string,consequence:string,fields:PackField[]=[]):PackAction=>({id,label,consequence,fields});
/** The submitted map must match the freshly authorized form exactly. No injected field or action reaches an owner. */
export function validPackValues(a:PackAction,values:Record<string,PackValue>):boolean{
 if(Object.keys(values).length!==a.fields.length||a.fields.some(f=>!Object.prototype.hasOwnProperty.call(values,f.key)))return false;
 return a.fields.every(f=>{const v=values[f.key];if(v===null||v==='')return !f.required;
  if(f.kind==='boolean')return typeof v==='boolean'&&(!f.required||v);
  if(f.kind==='number')return typeof v==='number'&&Number.isFinite(v);
  if(typeof v!=='string'||v.length>4000||f.required&&!v.trim()||f.minLength&&v.trim().length<f.minLength)return false;
  if(f.kind==='choice')return !!f.options?.some(o=>o.value===v);
  if(f.kind==='date')return z.iso.date().safeParse(v).success;
  return true;
 });
}
