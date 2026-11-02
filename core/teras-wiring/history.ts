/** Spec v6 (ADR-0169 §5.1 defect 3): only the model-side transcript is ever sent back as history.
 *
 * The open conversation's model-side transcript (each turn's TurnResult.modelTurn: the screened question or a
 * marker, and the reply as the model wrote it, with bands and placeholders, never a restored value) travels with
 * the browser's open chat as a signed continuation, bound to the tenant, login, conversation and current authority, and
 * expiring two hours after the turn. The server accepts history only through verifyConversationContinuation, so
 * neither the person-side reply nor any text the browser makes up can become history. Nothing is stored for it;
 * a new chat or a reload starts a new conversation. The key is derived from TERAS_PROPOSAL_SECRET under its own
 * domain; without that secret no continuation is issued or accepted. */
import {createHmac,randomUUID,timingSafeEqual} from 'node:crypto';
import type {SessionContext} from '../../db/client';
import type {ModelHistoryMessage} from '../harness/runner';
import {authorityKey} from '../harness/memory';

// Key domain stays unchanged: authentic legacy tc1 tokens can be checked before restarting.
const DOMAIN='teras:conversation-history:v1';
const TTL_MS=2*60*60*1000;
/** Earlier turns sent back, newest last: twelve turns of question and reply. */
export const MAX_HISTORY_MESSAGES=24;
const MAX_MESSAGE_CHARS=8000;
const MAX_TOKEN_CHARS=200_000;

export class ContinuationRefused extends Error{constructor(){super('The conversation continuation could not be confirmed.');this.name='ContinuationRefused';}}
const key=():Buffer=>{
 const value=process.env.TERAS_PROPOSAL_SECRET;
 if(typeof value!=='string'||Buffer.byteLength(value,'utf8')<32)throw new ContinuationRefused();
 return createHmac('sha256',value).update(DOMAIN).digest();
};
const sign=(payload:string)=>createHmac('sha256',key()).update(payload).digest('base64url');
type HistoryPayload={t:string;u:string;c:string;h:{role:'user'|'assistant';content:string}[];e:number};
type Payload=(HistoryPayload&{v:1})|(HistoryPayload&{v:2;a:string});

export type Conversation=Readonly<{conversationId:string;history:readonly ModelHistoryMessage[]}>;
export const newConversation=():Conversation=>Object.freeze({conversationId:randomUUID(),history:Object.freeze([])});

export function issueConversationContinuation(ctx:SessionContext,conversationId:string,history:readonly ModelHistoryMessage[],now=Date.now()):string{
 if(!ctx.userId||history.some(row=>row.side!=='model'))throw new ContinuationRefused();
 const kept=history.slice(-MAX_HISTORY_MESSAGES).map(row=>({role:row.role,content:row.content.slice(0,MAX_MESSAGE_CHARS)}));
 const payload=Buffer.from(JSON.stringify({v:2,t:ctx.tenantId,u:ctx.userId,c:conversationId,a:authorityKey(ctx),h:kept,e:now+TTL_MS} satisfies Payload)).toString('base64url');
 return 'tc2.'+payload+'.'+sign(payload);
}

export function verifyConversationContinuation(ctx:SessionContext,token:unknown,now=Date.now()):Conversation{
 if(typeof token!=='string'||token.length>MAX_TOKEN_CHARS)throw new ContinuationRefused();
 const [prefix,payload,signature,extra]=token.split('.');
 if((prefix!=='tc1'&&prefix!=='tc2')||!payload||!signature||extra!==undefined)throw new ContinuationRefused();
 const expected=Buffer.from(sign(payload)),given=Buffer.from(signature);
 if(expected.length!==given.length||!timingSafeEqual(expected,given))throw new ContinuationRefused();
 let value:Payload;
 try{value=JSON.parse(Buffer.from(payload,'base64url').toString('utf8')) as Payload;}catch{throw new ContinuationRefused();}
 if(!value||typeof value!=='object'||Array.isArray(value)
  ||value.v!==(prefix==='tc2'?2:1)
  ||Object.keys(value).sort().join(',')!==(prefix==='tc2'?'a,c,e,h,t,u,v':'c,e,h,t,u,v')
  ||(value.v===2&&(typeof value.a!=='string'||!/^[a-f0-9]{64}$/.test(value.a)))
  ||value.t!==ctx.tenantId||value.u!==ctx.userId||typeof value.c!=='string'||!/^[0-9a-f-]{36}$/.test(value.c)
  ||!Number.isSafeInteger(value.e)||value.e<=now||!Array.isArray(value.h)||value.h.length>MAX_HISTORY_MESSAGES)throw new ContinuationRefused();
 const history=value.h.map(row=>{
  if(!row||typeof row!=='object'||Array.isArray(row)||Object.keys(row).sort().join(',')!=='content,role'
   ||(row.role!=='user'&&row.role!=='assistant')||typeof row.content!=='string'||row.content.length>MAX_MESSAGE_CHARS)throw new ContinuationRefused();
  return Object.freeze({role:row.role,content:row.content,side:'model' as const});
 });
 // Owner decision, 3 November 2026: validate the entire token BEFORE any restart.
 // Same-user authority changes, or authentic legacy tokens without an authority witness,
 // start a fresh conversation; invalid/expired/cross-login tokens still refuse above.
 // Old memory/transcripts keep their existing retention and erasure owners.
 if(value.v===1||value.a!==authorityKey(ctx))return newConversation();
 return Object.freeze({conversationId:value.c,history:Object.freeze(history)});
}
