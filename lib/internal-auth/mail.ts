import { randomUUID } from 'node:crypto';
import { client, withTenant } from '../../db/client';
import { sql } from 'drizzle-orm';
import { EmailSettingsError, emailConfigSchema, type EmailSettingsRequest, type EmailSettingsView } from '../identity/email-model';
import { authTransaction, readRecord, writeRecord } from './store';
import { opaque } from './crypto';
import { sendSmtp, type Relay, type Mail, type MailTransport } from './smtp';
export { sendSmtp } from './smtp';
export type { Relay, Mail, MailTransport } from './smtp';

type Draft = Relay & { id: string; revision: string; testedAt: number | null };
type MailState = { revision: string; active: Relay | null; drafts: Record<string, Draft> };
const STATE = 'email-state';
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
      return { active: state.active ? { ...state.active.config, hasPassword: Boolean(state.active.password) } : null,
        revision: state.revision, draft: draft ? { id: draft.id, config: draft.config, hasPassword: Boolean(draft.password), testedAt: draft.testedAt ? new Date(draft.testedAt).toISOString() : null } : null,
        testRecipient: identity.email } satisfies EmailSettingsView as T;
    }
    if (request.op === 'save') {
      if (request.revision !== state.revision) throw new EmailSettingsError('conflict');
      const config = emailConfigSchema.parse(request.config);
      if ((request.password?.length || 0) > 4096) throw new EmailSettingsError('invalid');
      const previous = draft || state.active;
      const password = !config.auth ? undefined : request.password ||
        (previous?.config.host === config.host && previous.config.user === config.user ? previous.password : undefined);
      if (config.auth && !password) throw new EmailSettingsError('invalid');
      state.drafts[identity.subject] = { config, password, id: randomUUID(), revision: state.revision, testedAt: null };
    } else {
      if (!draft || draft.id !== request.draftId || draft.revision !== state.revision) throw new EmailSettingsError('conflict');
      if (request.op === 'test') {
        // An accepted test is not human receipt. Activation separately requires the explicit receipt checkbox.
        draft.testedAt = null;
        try { await transport(draft, { to: identity.email!, subject: 'AI HR email delivery test', text: 'This verifies email delivery for your AI HR installation. Return to Admin → Email delivery and confirm receipt to activate it.' }); }
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
