import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {beforeEach,expect,it,vi} from 'vitest';
import {locales} from '../i18n/config';
import {messagesForLocale} from '../i18n/catalogs';
const f=vi.hoisted(()=>({cookie:'en'}));
vi.mock('next/headers',()=>({cookies:async()=>({get:()=>({value:f.cookie})})}));
vi.mock('next-intl/server',()=>({getRequestConfig:(read:unknown)=>read}));
import request from '../i18n/request';
type Dict=Record<string,unknown>;
function leaves(value:Dict,prefix='',out:Dict={}):Dict{
 for(const [key,item]of Object.entries(value)){
  const path=prefix?prefix+'.'+key:key;
  if(item&&typeof item==='object'&&!Array.isArray(item))leaves(item as Dict,path,out);
  else if(item!==''&&item!=null)out[path]=item;
 }
 return out;
}
function source(locale:string){
 return Object.assign({},...['messages/','messages/ai-centre/'].map(directory=>leaves(JSON.parse(readFileSync(resolve(__dirname,'..',directory+locale+'.json'),'utf8')))));
}
beforeEach(()=>{f.cookie='en';});
it.each(locales)('retains every source message and English fallback for %s in the shared static catalogue',async locale=>{
 const promise=messagesForLocale(locale);
 expect(messagesForLocale(locale)).toBe(promise);
 const messages=await promise;
 expect(leaves(messages)).toEqual({...source('en'),...source(locale)});
 expect(messagesForLocale(locale)).toBe(promise);
});
it('keeps explicit document-language requests separate from the current UI cookie',async()=>{
 const read=request as unknown as (input:{locale?:string})=>Promise<{locale:string;messages:unknown}>;
 f.cookie='ms';
 const explicit=await read({locale:'zh'}),ordinary=await read({});
 expect(explicit).toEqual({locale:'zh',messages:await messagesForLocale('zh')});
 expect(ordinary).toEqual({locale:'ms',messages:await messagesForLocale('ms')});
 f.cookie='unrecognized';expect(await read({locale:'unrecognized'})).toEqual({locale:'en',messages:await messagesForLocale('en')});
});
