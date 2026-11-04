'use server';

import {revalidatePath} from 'next/cache';
import {getBrowserCommandSession} from '@/lib/session';
import {ChatRetentionRefused,deleteOwnChat,eraseOwnChats,listOwnChats,readChatRetention,setChatRetention,type ChatKeepDays} from '@/core/teras-chats';
import {assistantBrowserConversationScope} from './conversation-scope';

/** AI Centre issue 8 — the stored-chat commands the AI Centre revamp will put on screen: my chats, delete one, erase
 * all, and the tenant's "Keep chats for". No screen uses them yet (the owner chose to redesign AI Centre first); reopening
 * a chat is openStoredChatAction (./launcher-actions.ts). No posted user, tenant, scope or retention owner is accepted:
 * the session and core/teras-chats.ts decide everything. Results carry closed codes, never a database message, so the
 * revamp chooses the words. */
export type ChatActionFailure={ok:false;code:'unavailable'|'not_administrator'|'invalid'};
const unavailable:ChatActionFailure={ok:false,code:'unavailable'};

export async function listChatsAction(input:{cursor?:unknown}={}):Promise<{ok:true;chats:readonly {chatId:string;title:string|null;startedAt:string;lastMessageAt:string;expiresAt:string;turns:number;withheldTurns:number}[];nextCursor:string|null}|ChatActionFailure>{
 try{
  const session=await getBrowserCommandSession();
  const page=await listOwnChats(session,{cursor:input.cursor},await assistantBrowserConversationScope(session));
  return {ok:true,chats:page.chats.map(chat=>({chatId:chat.chatId,title:chat.title,startedAt:chat.startedAt.toISOString(),lastMessageAt:chat.lastMessageAt.toISOString(),
   expiresAt:chat.expiresAt.toISOString(),turns:chat.turns,withheldTurns:chat.withheldTurns})),nextCursor:page.nextCursor};
 }catch{return unavailable;}
}

/** Deletes one of my chats now, with its task memory. Works after Assistant access is removed. */
export async function deleteChatAction(input:{chatId:unknown}):Promise<{ok:true;deleted:number}|ChatActionFailure>{
 try{const deleted=await deleteOwnChat(await getBrowserCommandSession(),input.chatId);revalidatePath('/assistant');return {ok:true,deleted};}
 catch{return unavailable;}
}

/** Erases every one of my chats now, with their task memory. Works after Assistant access is removed. */
export async function eraseAllChatsAction():Promise<{ok:true;erased:number}|ChatActionFailure>{
 try{const erased=await eraseOwnChats(await getBrowserCommandSession());revalidatePath('/assistant');return {ok:true,erased};}
 catch{return unavailable;}
}

export async function chatRetentionAction():Promise<{ok:true;keepDays:ChatKeepDays;version:number|null;changedAt:string|null}|ChatActionFailure>{
 try{const value=await readChatRetention(await getBrowserCommandSession());return {ok:true,keepDays:value.keepDays,version:value.version,changedAt:value.changedAt?.toISOString()??null};}
 catch{return unavailable;}
}

/** A group administrator sets "Keep chats for" (1, 7, 30, 90, 180 or 365 days); every change is audited by the owner. */
export async function setChatRetentionAction(input:{keepDays:unknown}):Promise<{ok:true;keepDays:ChatKeepDays;version:number|null}|ChatActionFailure>{
 try{const value=await setChatRetention(await getBrowserCommandSession(),{keepDays:input.keepDays});revalidatePath('/assistant');return {ok:true,keepDays:value.keepDays,version:value.version};}
 catch(error){return error instanceof ChatRetentionRefused?{ok:false,code:error.reason}:unavailable;}
}
