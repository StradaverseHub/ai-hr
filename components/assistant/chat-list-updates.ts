"use client";
/** Presentation-only summaries, never session, scope or continuation authority. No local persistence. */
export type ChatListSnapshot={chats:readonly {threadId:string;exchangeId:string;title:string}[];nextCursor:string|null;scopeDigest:string};
const eventName='assistant:chat-list-snapshot';
let sequence=0;
export const beginChatListUpdate=()=>++sequence;
const uuid=(value:unknown):value is string=>typeof value==='string'&&/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(value);
function snapshot(value:unknown):value is ChatListSnapshot{
 if(!value||typeof value!=='object')return false;const page=value as ChatListSnapshot;
 return typeof page.scopeDigest==='string'&&/^[a-f0-9]{64}$/.test(page.scopeDigest)&&
  (page.nextCursor===null||typeof page.nextCursor==='string'&&page.nextCursor.length<=256)&&
  Array.isArray(page.chats)&&page.chats.length<=20&&page.chats.every(row=>row&&uuid(row.threadId)&&uuid(row.exchangeId)&&typeof row.title==='string'&&row.title.length<=100);
}
export function publishChatListUpdate(ticket:number,page:ChatListSnapshot){
 if(typeof window!=='undefined'&&Number.isSafeInteger(ticket)&&ticket>0&&snapshot(page))window.dispatchEvent(new CustomEvent(eventName,{detail:{ticket,page}}));
}
/** An authoritative route render/erasure advances the fence. A response begun before it cannot
 * repopulate erased summaries, even if the scope digest and first-page values did not change. */
export function observeChatListUpdates(scopeDigest:string,apply:(page:ChatListSnapshot)=>void){
 let latest=beginChatListUpdate();
 const receive=(event:Event)=>{const detail=(event as CustomEvent<unknown>).detail;if(!detail||typeof detail!=='object')return;
  const {ticket,page}=detail as {ticket:unknown;page:unknown};
  if(typeof ticket==='number'&&Number.isSafeInteger(ticket)&&ticket>=latest&&snapshot(page)&&page.scopeDigest===scopeDigest){latest=ticket;apply(page);}
 };
 window.addEventListener(eventName,receive);return()=>window.removeEventListener(eventName,receive);
}
