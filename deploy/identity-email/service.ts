import { createHmac, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { emailConfigSchema, identityEmailActorSchema, EmailSettingsError, type EmailConfig, type EmailSettingsView, type IdentityEmailActor } from '../../lib/identity/email-model';

type Realm = {smtpServer?:Record<string,string>;resetPasswordAllowed?:boolean};
type Draft = {id:string;config:EmailConfig;vaultKey:string|null;revision:string;testedAt:string|null};
export type EmailState = {drafts:Record<string,Draft>;active:{config:EmailConfig;vaultKey:string|null}|null};
export interface EmailDependencies {
  authorize(actor:IdentityEmailActor):Promise<string|null>;
  audit(actor:IdentityEmailActor,action:string,meta:Record<string,unknown>):Promise<void>;
  realm(method?:string,body?:unknown):Promise<Realm>;
  test(smtp:Record<string,string>):Promise<void>;
  load():Promise<EmailState>; store(state:EmailState):Promise<void>;
  vault(key:string,password:string):Promise<void>;
  revisionKey:string; testRecipient:string; now():Date;
}
const requestSchema=z.discriminatedUnion('op',[
 z.object({op:z.literal('readiness')}).strict(),
 z.object({op:z.literal('view'),actor:identityEmailActorSchema}).strict(),
 z.object({op:z.literal('save'),actor:identityEmailActorSchema,revision:z.string().length(64),config:emailConfigSchema,password:z.string().max(4096).optional()}).strict(),
 z.object({op:z.literal('test'),actor:identityEmailActorSchema,draftId:z.uuid()}).strict(),
 z.object({op:z.literal('apply'),actor:identityEmailActorSchema,draftId:z.uuid(),received:z.boolean()}).strict(),
]);
function smtp(c:EmailConfig,vaultKey:string|null):Record<string,string> {
 return {host:c.host,port:String(c.port),ssl:'true',starttls:'false',auth:String(c.auth),authType:'basic',from:c.from,fromDisplayName:c.fromName,replyTo:c.replyTo,user:c.auth?c.user:'',...(c.auth&&vaultKey?{password:'${vault.'+vaultKey+'}'}:{})};
}
function config(r:Realm):EmailSettingsView['active'] {
 const s=r.smtpServer;if(!s?.host) return null;
 const parsed=emailConfigSchema.safeParse({host:s.host,port:Number(s.port||465),security:s.ssl==='true'?'tls':'unsupported',auth:s.auth==='true',user:s.user||'',from:s.from||'',fromName:s.fromDisplayName||'',replyTo:s.replyTo||''});
 return parsed.success?{...parsed.data,hasPassword:!!s.password}:null;
}
/** Serialized mutations protect drafts from concurrent saves/tests/applies within this installation. */
export function createEmailService(d:EmailDependencies) {
 let queue:Promise<unknown>=Promise.resolve();
 async function handle(input:unknown):Promise<unknown> {
  const parsed=requestSchema.safeParse(input);if(!parsed.success) throw new EmailSettingsError('invalid');
  const req=parsed.data;
  if(req.op!=='readiness') {
   const recipient=await d.authorize(req.actor);
   if(!recipient||recipient.toLowerCase()!==d.testRecipient.toLowerCase()) throw new EmailSettingsError('forbidden');
  }
  const state=await d.load(),realm=await d.realm();
  const revision=createHmac('sha256',d.revisionKey).update(JSON.stringify({smtp:Object.entries(realm.smtpServer||{}).sort(([a],[b])=>a.localeCompare(b)),reset:realm.resetPasswordAllowed,active:state.active})).digest('hex');
  const active=config(realm);
  const managed=!!active&&!!state.active&&JSON.stringify({...active,hasPassword:undefined})===JSON.stringify({...state.active.config,hasPassword:undefined});
  if(req.op==='readiness') return {ready:managed&&realm.resetPasswordAllowed===true};
  const actor=req.actor,actorKey=createHmac('sha256',d.revisionKey).update(actor.issuer+'\0'+actor.subject).digest('hex');
  const view=():EmailSettingsView=>{const draft=state.drafts[actorKey];return {active,revision,testRecipient:d.testRecipient,draft:draft?{id:draft.id,config:draft.config,hasPassword:!!draft.vaultKey,testedAt:draft.testedAt}:null};};
  if(req.op==='view') return view();
  if(req.op==='save') {
   if(req.revision!==revision) throw new EmailSettingsError('conflict');
   let vaultKey=state.drafts[actorKey]?.vaultKey||(managed?state.active?.vaultKey:null)||null;
   if(req.config.auth && req.password) {vaultKey='smtp-'+randomUUID();await d.vault(vaultKey,req.password);}
   if(req.config.auth&&!vaultKey) throw new EmailSettingsError('invalid');
   if(!req.config.auth) vaultKey=null;
   const draft:Draft={id:randomUUID(),config:req.config,vaultKey,revision,testedAt:null};
   await d.audit(actor,'draft-saved',{draftId:draft.id,passwordChanged:!!req.password});
   state.drafts[actorKey]=draft;await d.store(state);return view();
  }
  const draft=state.drafts[actorKey];
  if(!draft||draft.id!==req.draftId||draft.revision!==revision) throw new EmailSettingsError('conflict');
  if(req.op==='test') {
   draft.testedAt=null;await d.store(state);await d.audit(actor,'test-requested',{draftId:draft.id});
   try {await d.test(smtp(draft.config,draft.vaultKey));}
   catch {await d.audit(actor,'test-failed',{draftId:draft.id,outcome:'rejected'});throw new EmailSettingsError('rejected');}
   draft.testedAt=d.now().toISOString();await d.audit(actor,'test-accepted',{draftId:draft.id});await d.store(state);return view();
  }
  if(!draft.testedAt||d.now().getTime()-Date.parse(draft.testedAt)>30*60_000) throw new EmailSettingsError('needsTest');
  if(!req.received) throw new EmailSettingsError('needsReceipt');
  await d.audit(actor,'apply-requested',{draftId:draft.id});
  try {await d.realm('PUT',{smtpServer:smtp(draft.config,draft.vaultKey),resetPasswordAllowed:true});}
  catch {await d.audit(actor,'apply-uncertain',{draftId:draft.id,outcome:'uncertain'});throw new EmailSettingsError('uncertain');}
  try {
   const confirmed=await d.realm();
   const observed=config(confirmed);
   if(!observed||JSON.stringify({...observed,hasPassword:undefined})!==JSON.stringify({...draft.config,hasPassword:undefined})||confirmed.resetPasswordAllowed!==true) throw new Error('Unconfirmed realm update');
   state.active={config:draft.config,vaultKey:draft.vaultKey};delete state.drafts[actorKey];await d.store(state);
  }catch{await d.audit(actor,'apply-uncertain',{draftId:draft.id,outcome:'uncertain'});throw new EmailSettingsError('uncertain');}
  try{await d.audit(actor,'applied',{draftId:draft.id});}catch{throw new EmailSettingsError('appliedAuditFailed');}
  return {applied:true};
 }
 return (input:unknown)=>{const result=queue.then(()=>handle(input));queue=result.catch(()=>{});return result;};
}
