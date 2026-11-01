import 'server-only';
import manifest from './client-message-scopes.json';
import {additionalClientMessages,pickClientMessages,type ClientMessages,type ClientMessageScopes} from '../lib/client-message-tree';
const scopes=manifest as ClientMessageScopes;
// Public, immutable catalog objects only. Weak keys release per-request locale fallback catalogs.
const cache=new WeakMap<ClientMessages,{shared:ClientMessages;routes:Map<readonly string[]|null,ClientMessages>}>();
function entry(messages:ClientMessages){
 let value=cache.get(messages);
 if(!value){value={shared:pickClientMessages(messages,scopes.shared.prefixes),routes:new Map()};cache.set(messages,value);}
 return value;
}
export function sharedClientMessages(messages:ClientMessages){return entry(messages).shared;}
export function routeClientMessages(messages:ClientMessages,pathname:string){
 const segment=pathname.startsWith('/')?pathname.split('/')[1]:null;
 const prefixes=segment!==null&&Object.hasOwn(scopes.segments,segment)?scopes.segments[segment].prefixes:null;
 const value=entry(messages);let result=value.routes.get(prefixes);
 if(!result){result=additionalClientMessages(pickClientMessages(messages,prefixes),value.shared);value.routes.set(prefixes,result);}
 return result;
}
