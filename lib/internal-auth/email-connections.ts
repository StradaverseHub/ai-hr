import {randomBytes,randomUUID} from 'node:crypto';
import {EmailSettingsError,sameEmailCredential,type EmailConfig} from '../identity/email-model';
import type {StoredEmailRelay} from '../identity/email-relay';

export type SavedEmailConnection=StoredEmailRelay&{id:string;name:string;version:string;testedAt:number|null;testedBy:string|null;testedAgainstRevision?:string};
export type ConnectionState={revision:string;active:StoredEmailRelay|null;connectionsRevision?:string;connections?:Record<string,SavedEmailConnection>;activeConnectionId?:string;activeConnectionVersion?:string;drafts?:Record<string,StoredEmailRelay&{id:string;testedAt:number|null;revision?:string}>};
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
 records[id]={id,name,config:input.config,password,version:randomUUID(),testedAt:null,testedBy:null,testedAgainstRevision:state.revision};
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
