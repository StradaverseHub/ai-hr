import { managedEmailSenderProfiles, type ManagedEmailSenderProfile } from '../managed-email-policy';
import {randomBytes,randomUUID} from 'node:crypto';
import {EmailSettingsError,sameEmailCredential,type EmailConfig} from '../identity/email-model';
import type {StoredEmailRelay} from '../identity/email-relay';

export type SavedEmailConnection=StoredEmailRelay&{id:string;name:string;version:string;testedAt:number|null;testedBy:string|null;testedAgainstRevision?:string;testedAgainstLifecycleRevision?:string};
export type LifecycleSenderBinding={connectionId:string;version:string;relay:StoredEmailRelay;revision:string;appliedAt:number;appliedBy:string};
export type ConnectionState={lifecycleRevision?:string;lifecycleSenders?:Record<string,Partial<Record<ManagedEmailSenderProfile,LifecycleSenderBinding>>>;revision:string;active:StoredEmailRelay|null;connectionsRevision?:string;connections?:Record<string,SavedEmailConnection>;activeConnectionId?:string;activeConnectionVersion?:string;drafts?:Record<string,StoredEmailRelay&{id:string;testedAt:number|null;revision?:string}>};
const revision=()=>randomBytes(32).toString('base64url');
/** Upgrade only the encrypted record's representation; the working relay remains byte-for-byte intact. */
export function emailConnections(state:ConnectionState):Record<string,SavedEmailConnection>{
 const records={...state.connections};
 if(state.active&&!state.activeConnectionId){
  records['current-relay']={...state.active,id:'current-relay',name:state.active.config.fromName||state.active.config.host,version:'current-relay',testedAt:null,testedBy:null};
  state.activeConnectionId='current-relay';state.activeConnectionVersion='current-relay';
 }
 for(const [subject,draft] of Object.entries(state.drafts??{})){
  const id='draft-'+draft.id;if(Object.hasOwn(records,id))continue;
  const base=draft.config.fromName||draft.config.host||'SMTP';let name=base,index=2;
  while(Object.values(records).some(c=>c.name.toLowerCase()===name.toLowerCase()))name=`${base} (${index++})`;
  records[id]={config:draft.config,password:draft.password,id,name,version:draft.id,testedAt:draft.testedAt,testedBy:draft.testedAt?subject:null,testedAgainstRevision:draft.revision??state.revision};
 }
 state.connections=records;return records;
}
export function publicEmailConnections(state:ConnectionState){
 return Object.values(emailConnections(state)).map(c=>({id:c.id,name:c.name,config:c.config,hasPassword:Boolean(c.password),
  active:state.activeConnectionId===c.id,hasUnappliedChanges:state.activeConnectionId===c.id&&state.activeConnectionVersion!==c.version,
  testedAt:c.testedAt?new Date(c.testedAt).toISOString():null}));
}
export function saveEmailConnection(state:ConnectionState,input:{id?:string;name:string;config:EmailConfig;password?:string;revision:string}){
 if(input.revision!==(state.connectionsRevision??state.revision))throw new EmailSettingsError('conflict');
 const records=emailConnections(state),previous=input.id&&Object.hasOwn(records,input.id)?records[input.id]:undefined;
 if(input.id&&!previous)throw new EmailSettingsError('conflict');
 const name=input.name.trim();if(!name||name.length>120||/[\x00-\x1f\x7f]/.test(name))throw new EmailSettingsError('invalid');
 if(Object.values(records).some(c=>c.id!==input.id&&c.name.toLowerCase()===name.toLowerCase()))throw new EmailSettingsError('invalid');
 if(!previous&&Object.keys(records).length>=25)throw new EmailSettingsError('invalid');
 if((input.password?.length??0)>4096)throw new EmailSettingsError('invalid');
 const password=input.config.auth?(input.password||(previous&&sameEmailCredential(previous.config,input.config)?previous.password:undefined)):undefined;
 if(input.config.auth&&!password)throw new EmailSettingsError('invalid');
 const id=previous?.id??randomUUID();
 records[id]={id,name,config:input.config,password,version:randomUUID(),testedAt:null,testedBy:null,testedAgainstRevision:state.revision,testedAgainstLifecycleRevision:state.lifecycleRevision??'initial'};
 state.connectionsRevision=revision();return records[id];
}
export function testedEmailConnection(state:ConnectionState,id:string,version:string){
 const records=emailConnections(state),c=Object.hasOwn(records,id)?records[id]:undefined;if(!c||c.version!==version)throw new EmailSettingsError('conflict');return c;
}
export function activateEmailConnection(state:ConnectionState,id:string,version:string,subject:string,received:boolean,now=Date.now()){
 const c=testedEmailConnection(state,id,version);
 if(!received)throw new EmailSettingsError('needsReceipt');
 if(!c.testedAt||c.testedBy!==subject||c.testedAgainstRevision!==state.revision||c.testedAt<now-30*60_000)throw new EmailSettingsError('needsTest');
 state.active={config:c.config,password:c.password};state.activeConnectionId=c.id;state.activeConnectionVersion=c.version;state.revision=revision();state.connectionsRevision=revision();
}

/** Receipt-confirmed version snapshots are tenant/profile-bound; editing the saved connection cannot change a working sender. */
export function bindLifecycleEmailConnection(state:ConnectionState,tenantId:string,profile:ManagedEmailSenderProfile,id:string,version:string,subject:string,received:boolean,now=Date.now()) {
 if(!managedEmailSenderProfiles.includes(profile)||!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(tenantId))throw new EmailSettingsError('invalid');
 const c=testedEmailConnection(state,id,version);
 if(!received)throw new EmailSettingsError('needsReceipt');
 if(!c.testedAt||c.testedBy!==subject||c.testedAgainstRevision!==state.revision||c.testedAt<now-30*60_000)throw new EmailSettingsError('needsTest');
 if((c.testedAgainstLifecycleRevision??'initial')!==(state.lifecycleRevision??'initial'))throw new EmailSettingsError('needsTest');
 state.lifecycleSenders??={};state.lifecycleSenders[tenantId]??={};
 const appliedRevision=revision();state.lifecycleRevision=appliedRevision;
 state.lifecycleSenders[tenantId][profile]={connectionId:c.id,version:c.version,relay:structuredClone({config:c.config,password:c.password}),revision:appliedRevision,appliedAt:now,appliedBy:subject};
 state.connectionsRevision=revision();
}
export function publicLifecycleSenders(state:ConnectionState,tenantId:string) {
 return managedEmailSenderProfiles.map(profile=>{
  const binding=state.lifecycleSenders?.[tenantId]?.[profile],connection=binding?state.connections?.[binding.connectionId]:undefined;
  return {profile,from:binding?.relay.config.from??state.active?.config.from??null,hasUnappliedChanges:!!binding&&(!connection||connection.version!==binding.version||JSON.stringify(connection.config)!==JSON.stringify(binding.relay.config)||connection.password!==binding.relay.password),
   ...(binding?{connectionId:binding.connectionId,appliedAt:new Date(binding.appliedAt).toISOString()}:{})};
 });
}
