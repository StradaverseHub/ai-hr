import { randomUUID } from 'node:crypto';
import { client, withTenant } from '../../db/client';
import { sql } from 'drizzle-orm';
import { EmailSettingsError, emailConfigSchema, sameEmailCredential, type EmailSettingsRequest, type EmailSettingsView } from '../identity/email-model';
import { authTransaction, readRecord, writeRecord } from './store';
import { opaque } from './crypto';
import { INTERNAL_EMAIL_STATE_KEY } from './active-relay';
import { sendSmtp, type Relay, type Mail, type MailTransport } from './smtp';
import type {StoredEmailRelay} from '../identity/email-relay';
import {bindLifecycleEmailConnection,publicLifecycleSenders,publicEmailConnections,saveEmailConnection,testedEmailConnection,activateEmailConnection,type ConnectionState} from './email-connections';
export { sendSmtp } from './smtp';
export type { Relay, Mail, MailTransport } from './smtp';

type Draft = StoredEmailRelay & { id: string; revision: string; testedAt: number | null };
type MailState = ConnectionState & {drafts: Record<string, Draft>};
const STATE = INTERNAL_EMAIL_STATE_KEY;
const emptyState = (): MailState => ({ revision: 'initial', active: null, drafts: {} });
export async function recoveryMailReady() { return Boolean((await readRecord<MailState>(client, STATE))?.active); }
export async function internalEmailRequest<T>(request: EmailSettingsRequest, transport: MailTransport = sendSmtp): Promise<T> {
  if (request.op === 'readiness') return { ready: await recoveryMailReady() } as T;
  const { currentInternalIdentity } = await import('./web-session');
  const { getSession } = await import('../session');
  const identity = await currentInternalIdentity(), ctx = await getSession();
  const actor = request.actor;
  if (!identity || actor.issuer !== identity.issuer || actor.subject !== identity.subject || actor.userId !== ctx.userId || actor.tenantId !== ctx.tenantId || !identity.emailVerified)
    throw new EmailSettingsError('forbidden');
  const allowed = await withTenant(ctx, async tx => {
    const rows = await tx.execute(sql`select app.internal_auth_email_operator(${identity.issuer},${identity.subject},${identity.email}) allowed`) as unknown as { allowed: boolean }[];
    return rows[0]?.allowed === true;
  });
  if (!allowed) throw new EmailSettingsError('forbidden');
  return authTransaction(STATE, async tx => {
    const state = await readRecord<MailState>(tx, STATE, true) || emptyState();
    const draft = state.drafts[identity.subject];
    if (request.op === 'view') {
      const connections=publicEmailConnections(state);
      const selected=request.connectionId&&state.connections&&Object.hasOwn(state.connections,request.connectionId)?state.connections[request.connectionId]:undefined;
      if(request.connectionId&&request.connectionId!=='new'&&!selected)throw new EmailSettingsError('conflict');
      return { active: state.active ? { ...state.active.config, hasPassword: Boolean(state.active.password) } : null,
        supportsLifecycleSenders:true,lifecycleSenders:publicLifecycleSenders(state,ctx.tenantId),
        connections,selectedConnectionId:selected?.id,selectedConnectionName:selected?.name,
        revision: request.connectionId?state.connectionsRevision??state.revision:state.revision, draft: selected?{id:selected.version,config:selected.config,hasPassword:Boolean(selected.password),testedAt:selected.testedAt&&selected.testedBy===identity.subject&&selected.testedAgainstRevision===state.revision&&(selected.testedAgainstLifecycleRevision??'initial')===(state.lifecycleRevision??'initial')?new Date(selected.testedAt).toISOString():null}:request.connectionId?null:draft ? { id: draft.id, config: draft.config, hasPassword: Boolean(draft.password), testedAt: draft.testedAt ? new Date(draft.testedAt).toISOString() : null } : null,
        testRecipient: identity.email } satisfies EmailSettingsView as T;
    }
    if(request.op==='save'&&request.connectionName!==undefined){
      const connection=saveEmailConnection(state,{id:request.connectionId,name:request.connectionName,revision:request.revision,config:emailConfigSchema.parse(request.config),password:request.password});
      await writeRecord(tx,STATE,state,null);
      await tx.unsafe("select app.append_auth_event($1::uuid,'app-user',$2::uuid,'identity-email.connection-saved','user',$2::uuid,$3::jsonb)",[ctx.tenantId,ctx.userId!,JSON.stringify({connectionId:connection.id,name:connection.name})]);
      return {ok:true,connectionId:connection.id} as T;
    }
    if((request.op==='test'||request.op==='apply')&&request.connectionId){
      const connection=testedEmailConnection(state,request.connectionId,request.draftId);
      if(request.op==='test'){
        connection.testedAt=null;connection.testedBy=null;
        try{await transport({config:connection.config,password:connection.password},{to:identity.email!,subject:'AI HR email delivery test',text:'This verifies email delivery for your AI HR installation. Return to Admin → Email delivery and confirm receipt to activate it.'});}
        catch{
          await writeRecord(tx,STATE,state,null);
          await tx.unsafe("select app.append_auth_event($1::uuid,'app-user',$2::uuid,'identity-email.test-failed','user',$2::uuid,$3::jsonb)",[ctx.tenantId,ctx.userId!,JSON.stringify({connectionId:connection.id})]);
          return {failed:true} as T;
        }
        connection.testedAt=Date.now();connection.testedBy=identity.subject;connection.testedAgainstRevision=state.revision;connection.testedAgainstLifecycleRevision=state.lifecycleRevision??'initial';
      }else if(request.lifecycleSender)bindLifecycleEmailConnection(state,ctx.tenantId,request.lifecycleSender,connection.id,request.draftId,identity.subject,request.received);
      else activateEmailConnection(state,connection.id,request.draftId,identity.subject,request.received);
      await writeRecord(tx,STATE,state,null);
      await tx.unsafe("select app.append_auth_event($1::uuid,'app-user',$2::uuid,$3,'user',$2::uuid,$4::jsonb)",[ctx.tenantId,ctx.userId!,request.op==='test'?'identity-email.test-accepted':request.lifecycleSender?'identity-email.lifecycle-sender-applied':'identity-email.applied',JSON.stringify({connectionId:connection.id,...(request.op==='apply'&&request.lifecycleSender?{profile:request.lifecycleSender}:{})})]);
      return {ok:true} as T;
    }
    if (request.op === 'apply' && request.lifecycleSender) throw new EmailSettingsError('invalid');
    if (request.op === 'save') {
      if (request.revision !== state.revision) throw new EmailSettingsError('conflict');
      const config = emailConfigSchema.parse(request.config);
      if ((request.password?.length || 0) > 4096) throw new EmailSettingsError('invalid');
      const previous = draft || state.active;
      const password = !config.auth ? undefined : request.password ||
        (previous&&sameEmailCredential(previous.config,config) ? previous.password : undefined);
      if (config.auth && !password) throw new EmailSettingsError('invalid');
      state.drafts[identity.subject] = { config, password, id: randomUUID(), revision: state.revision, testedAt: null };
    } else {
      if (!draft || draft.id !== request.draftId || draft.revision !== state.revision) throw new EmailSettingsError('conflict');
      if (request.op === 'test') {
        // An accepted test is not human receipt. Activation separately requires the explicit receipt checkbox.
        draft.testedAt = null;
        try { await transport({config:draft.config,password:draft.password}, { to: identity.email!, subject: 'AI HR email delivery test', text: 'This verifies email delivery for your AI HR installation. Return to Admin → Email delivery and confirm receipt to activate it.' }); }
        catch {
          await writeRecord(tx, STATE, state, null);
          await tx.unsafe("select app.append_auth_event($1::uuid,'app-user',$2::uuid,'identity-email.test-failed','user',$2::uuid,NULL)", [ctx.tenantId, ctx.userId!]);
          return { failed: true } as T;
        }
        draft.testedAt = Date.now();
      } else {
        if (!request.received) throw new EmailSettingsError('needsReceipt');
        if (!draft.testedAt || draft.testedAt < Date.now() - 30 * 60_000) throw new EmailSettingsError('needsTest');
        state.active = { config: draft.config, password: draft.password }; state.revision = opaque();
        delete state.activeConnectionId;delete state.activeConnectionVersion;
        delete state.connectionsRevision;
        delete state.drafts[identity.subject];
      }
    }
    await writeRecord(tx, STATE, state, null);
    await tx.unsafe("select app.append_auth_event($1::uuid,'app-user',$2::uuid,$3,'user',$2::uuid,NULL)",
      [ctx.tenantId, ctx.userId!, `identity-email.${request.op === 'apply' ? 'applied' : request.op === 'save' ? 'draft-saved' : 'test-accepted'}`]);
    return { ok: true } as T;
  }).then(result => {
    if (result && typeof result === 'object' && 'failed' in result) throw new EmailSettingsError('connectionFailed');
    return result;
  });
}
/** One selected delivery attempt. Held authentication-mail failures are never automatically replayed. */
export async function sendInternalMail(message: Mail, transport: MailTransport = sendSmtp) {
  const relay = (await readRecord<MailState>(client, STATE))?.active;
  if (!relay) throw new EmailSettingsError('unavailable');
  await transport(relay, message);
}
