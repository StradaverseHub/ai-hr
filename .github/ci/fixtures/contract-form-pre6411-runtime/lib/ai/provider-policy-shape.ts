/** Strict local policy data capture; no coercion, accessors, proxies or posted review flags. */
import {types as nodeTypes} from 'node:util';
import {createHash} from 'node:crypto';
import {AiPrivacyGateError} from './provider-privacy-request';
export const privatePolicyRefusal=():never=>{throw new AiPrivacyGateError('unsupported');};
export const privateHash=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
export function privateRecord(value:unknown,keys:readonly string[]):Record<string,unknown>{
 if(!value||typeof value!=='object'||nodeTypes.isProxy(value)||Array.isArray(value)||![Object.prototype,null].includes(Object.getPrototypeOf(value)))return privatePolicyRefusal();
 const descriptors=Object.getOwnPropertyDescriptors(value),actual=Reflect.ownKeys(descriptors);
 if(actual.length!==keys.length||actual.some(key=>typeof key!=='string'||!keys.includes(key)))return privatePolicyRefusal();
 const result=Object.create(null) as Record<string,unknown>;
 for(const key of keys){const item=descriptors[key];if(!item?.enumerable||!('value'in item))return privatePolicyRefusal();result[key]=item.value;}
 return result;
}
export function privateList(value:unknown,limit:number):unknown[]{
 if(!Array.isArray(value)||nodeTypes.isProxy(value)||Object.getPrototypeOf(value)!==Array.prototype||value.length>limit)return privatePolicyRefusal();
 const descriptors=Object.getOwnPropertyDescriptors(value);if(Reflect.ownKeys(descriptors).length!==value.length+1)return privatePolicyRefusal();
 return Array.from({length:value.length},(_,index)=>{const item=descriptors[String(index)];if(!item||!('value'in item))return privatePolicyRefusal();return item.value;});
}
export function privateCount(value:unknown,min:number,max:number):number{return typeof value==='number'&&Number.isSafeInteger(value)&&value>=min&&value<=max?value:privatePolicyRefusal();}
export function privateEnum<const T extends readonly string[]>(value:unknown,allowed:T):T[number]{return typeof value==='string'&&(allowed as readonly string[]).includes(value)?value:privatePolicyRefusal();}

/** Capture local adjudication dictionaries independently of caller-owned mutable references. */
export function privateLocalData(input:unknown):unknown{
 let nodes=0;
 const copy=(value:unknown,depth:number):unknown=>{
  if(++nodes>30000||depth>24)return privatePolicyRefusal();
  if(value===null||typeof value==='boolean'||typeof value==='string')return value;
  if(typeof value==='number')return Number.isFinite(value)?value:privatePolicyRefusal();
  if(!value||typeof value!=='object'||nodeTypes.isProxy(value))return privatePolicyRefusal();
  if(Array.isArray(value))return Object.freeze(privateList(value,30000).map(item=>copy(item,depth+1)));
  if(![Object.prototype,null].includes(Object.getPrototypeOf(value)))return privatePolicyRefusal();
  const descriptors=Object.getOwnPropertyDescriptors(value),result=Object.create(null) as Record<string,unknown>;
  for(const key of Reflect.ownKeys(descriptors)){const item=typeof key==='string'?descriptors[key]:undefined;if(typeof key!=='string'||!item?.enumerable||!('value'in item))return privatePolicyRefusal();result[key]=copy(item.value,depth+1);}
  return Object.freeze(result);
 };
 return input===undefined?undefined:copy(input,0);
}
