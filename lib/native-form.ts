/** Small native form helpers. Parse only a bounded stream; field values are always escaped on output. */
import {readBoundedBody} from './bounded-body';
export class NativeFormError extends Error{}
const entities:Record<string,string>={'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'};
export const escapeFormHtml=(value:unknown)=>String(value??'').replace(/[&<>"']/g,char=>entities[char]);
export const hiddenFormField=(name:string,value:string)=>`<input type="hidden" name="${escapeFormHtml(name)}" value="${escapeFormHtml(value)}">`;
export async function readNativeUrlForm(request:Request,maximum:number,allowed:ReadonlySet<string>,repeated:ReadonlySet<string>=new Set()):Promise<FormData>{
 if(!/^application\/x-www-form-urlencoded(?:\s*;|$)/i.test(request.headers.get('content-type')??''))throw new NativeFormError('Unsupported form encoding');
 const bytes=await readBoundedBody(request,maximum,20000,request.signal);
 let text:string;try{text=new TextDecoder('utf-8',{fatal:true}).decode(bytes);}catch{throw new NativeFormError('Invalid form encoding');}
 const data=new FormData();
 for(const [name,value] of new URLSearchParams(text)){
  if(!allowed.has(name)||!repeated.has(name)&&data.has(name))throw new NativeFormError('Invalid form fields');
  data.append(name,value);
 }
 return data;
}
