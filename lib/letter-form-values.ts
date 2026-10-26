import {LetterModelError,parseLetterValue,type LetterField,type LetterValue} from './letter-model';
/** Callers supply fresh authorized version bindings, never definitions from a submitted form. */
export function letterCustomValues(form:FormData,definitions:LetterField[]):Record<string,LetterValue|null>{
 const fields=definitions.filter(field=>field.source.startsWith('custom.')),allowed=new Set(fields.flatMap(field=>['custom:'+field.key+':value',...(field.kind==='currency'?['custom:'+field.key+':currency']:[])]));let characters=0;
 for(const [key,input]of form.entries())if(key.startsWith('custom:')){if(!allowed.has(key)||typeof input!=='string')throw new LetterModelError('invalid','fields');characters+=input.length;if(characters>256000)throw new LetterModelError('limit','document');}
 const value=(key:string)=>typeof form.get(key)==='string'?form.get(key) as string:'',result:Record<string,LetterValue|null>={};
 for(const field of fields){const input=value('custom:'+field.key+':value');result[field.key]=input.trim()?parseLetterValue({kind:field.kind,value:input,...(field.kind==='currency'?{currency:value('custom:'+field.key+':currency')}:{})},field.key):null;}
 return result;
}
