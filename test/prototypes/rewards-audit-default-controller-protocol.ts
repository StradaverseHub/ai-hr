/** Fixed private TEST owner-controller protocol, never a worker/API authority. */
import {z} from 'zod';
export const defaultControllerInput=z.discriminatedUnion('kind',[
 z.object({kind:z.literal('start'),nonce:z.guid(),ownerUrl:z.string().min(1).max(4096)}).strict(),
 z.object({kind:z.literal('continue'),nonce:z.guid()}).strict(),
]);
const identity={nonce:z.guid(),database:z.string().min(1).max(63),role:z.string().min(1).max(63),pid:z.number().int().positive(),started:z.string().min(20).max(100),xid:z.string().regex(/^[0-9]{1,20}$/)};
export const defaultControllerOutput=z.discriminatedUnion('kind',[
 z.object({...identity,kind:z.enum(['prepared','committed','completed'])}).strict(),
 z.object({kind:z.literal('refused'),phase:z.enum(['startup','context','reference','apply','commit','publication','cleanup'])}).strict(),
]);
export type DefaultControllerIdentity=Extract<z.infer<typeof defaultControllerOutput>,{kind:'prepared'|'committed'|'completed'}>;
export function defaultControllerApplication(nonce:string){return'rewards_default:'+z.guid().parse(nonce);}
