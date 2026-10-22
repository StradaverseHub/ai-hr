/** The explicit celebration-send boundary. A validated command is still untrusted intent:
 * its server owner must re-establish the actual USER, own EMP, dated audience and opt-outs.
 * Free text belongs only to erasable private content, never to an event or notification payload. */
import {isCalendarDate} from './calendar-date';

export const HOME_GREETING_MAX_CHARACTERS=500;
export type HomeGreetingCommand={
 version:1;employmentId:string;recipientEmploymentId:string;
 kind:'birthday'|'anniversary';occurrenceDate:string;nonce:string;message:string;
};
export type HomeGreetingReceipt={
 version:1;employmentId:string;nonce:string;greetingId:string;state:'sent'|'erased';
};
export class HomeGreetingInputError extends Error{
 constructor(){super('The greeting request is invalid.');this.name='HomeGreetingInputError';}
}
const invalid=():never=>{throw new HomeGreetingInputError();};
const uuid=/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
function id(value:unknown):string{
 if(typeof value!=='string'||!uuid.test(value)||value==='00000000-0000-0000-0000-000000000000')return invalid();
 return value.toLowerCase();
}
function object(raw:unknown,keys:readonly string[]):Record<string,unknown>{
 if(!raw||typeof raw!=='object'||Array.isArray(raw))return invalid();
 const prototype=Object.getPrototypeOf(raw);
 if(prototype!==null&&prototype!==Object.prototype)return invalid();
 const row=raw as Record<string,unknown>;
 if(Reflect.ownKeys(row).length!==keys.length||keys.some(key=>!Object.hasOwn(row,key)))return invalid();
 return row;
}
/** A bounded plain-text message. Preserve Unicode and internal spacing; never truncate or interpret
 * markup. Reject malformed Unicode and controls rather than hashing a lossy encoding of the text. */
export function homeGreetingMessage(raw:unknown):string{
 if(typeof raw!=='string'||raw.length>2*HOME_GREETING_MAX_CHARACTERS)return invalid();
 const message=raw.replace(/\r\n?/g,'\n').trim();
 if(!message||Array.from(message).length>HOME_GREETING_MAX_CHARACTERS
  ||/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(message)
  ||/[\uD800-\uDFFF]/u.test(message))return invalid();
 return message;
}
export function validateHomeGreetingCommand(raw:unknown):HomeGreetingCommand{
 const row=object(raw,['version','employmentId','recipientEmploymentId','kind','occurrenceDate','nonce','message']);
 if(row.version!==1||row.kind!=='birthday'&&row.kind!=='anniversary'
  ||typeof row.occurrenceDate!=='string'||!isCalendarDate(row.occurrenceDate))return invalid();
 const employmentId=id(row.employmentId),recipientEmploymentId=id(row.recipientEmploymentId);
 if(employmentId===recipientEmploymentId)return invalid();
 return {version:1,employmentId,recipientEmploymentId,kind:row.kind,occurrenceDate:row.occurrenceDate,
  nonce:id(row.nonce),message:homeGreetingMessage(row.message)};
}
/** The response carries only this sender's command receipt. An erased retry is a terminal receipt,
 * never permission to recreate content or dispatch another notification. No message is echoed here. */
export function validateHomeGreetingReceipt(raw:unknown,expected:{employmentId:string;nonce:string}):HomeGreetingReceipt{
 const row=object(raw,['version','employmentId','nonce','greetingId','state']);
 if(row.version!==1||row.state!=='sent'&&row.state!=='erased')return invalid();
 const receipt:HomeGreetingReceipt={version:1,employmentId:id(row.employmentId),nonce:id(row.nonce),
  greetingId:id(row.greetingId),state:row.state};
 if(receipt.employmentId!==id(expected.employmentId)||receipt.nonce!==id(expected.nonce))return invalid();
 return receipt;
}
