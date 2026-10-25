/** Anonymous card interaction counters. Never accept content, identities or destinations. */
import {EMPLOYEE_HOME_CARDS,type EmployeeHomeCard} from './employee-home';
export type HomeCardInteraction={card:EmployeeHomeCard;action:'view'|'click'};
export class HomeAnalyticsInputError extends Error{constructor(){super('Invalid Home interaction batch.');this.name='HomeAnalyticsInputError';}}
const invalid=():never=>{throw new HomeAnalyticsInputError();};
function exact(raw:unknown,keys:readonly string[]):Record<string,unknown>{
 if(!raw||typeof raw!=='object'||Array.isArray(raw)||![Object.prototype,null].includes(Object.getPrototypeOf(raw)))return invalid();
 const descriptors=Object.getOwnPropertyDescriptors(raw);
 if(Reflect.ownKeys(raw).length!==keys.length||keys.some(key=>!Object.hasOwn(descriptors,key)||!('value' in descriptors[key])))return invalid();
 return raw as Record<string,unknown>;
}
export function homeCardInteractions(raw:unknown):HomeCardInteraction[]{
 const root=exact(raw,['version','events']);
 if(root.version!==1||!Array.isArray(root.events)||root.events.length<1||root.events.length>16)return invalid();
 return root.events.map(raw=>{
  const event=exact(raw,['card','action']);
  if(!EMPLOYEE_HOME_CARDS.some(card=>card===event.card)||event.action!=='view'&&event.action!=='click')return invalid();
  return {card:event.card as EmployeeHomeCard,action:event.action};
 });
}
