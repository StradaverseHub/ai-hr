import { client } from '../../db/client';
import { createNotificationEmailService, type WorkflowMailTarget } from '../../deploy/identity-email/notifications';
import { workflowEmailMessage } from '../../deploy/identity-email/notification-message';
import type { NotificationEmailRequest } from '../notification-email-model';
import { internalConfig, internalIssuer } from './config';
import { recoveryMailReady, sendInternalMail, type MailTransport } from './mail';
import { readRecord } from './store';
import { assertActiveCredential, InternalAuthError, type Credential } from './service';
/** The same consent, fresh recipient and immutable event rules apply with HR-owned credentials. */
export async function internalNotificationEmailRequest<T>(input: NotificationEmailRequest, transport?: MailTransport): Promise<T> {
  const origin = internalConfig().origin;
  const service = createNotificationEmailService({
    origin, ready: recoveryMailReady,
    async target(id, token) {
      const rows = await client<WorkflowMailTarget[]>`select * from app.internal_auth_notification_target(${id}::uuid,${token}::uuid,${origin})`;
      return rows.length === 1 ? rows[0] : null;
    },
    async assessmentTasks(id, token) {
      const rows = await client`select * from app.internal_auth_notification_summary(${id}::uuid,${token}::uuid,${origin})`;
      return rows.length === 1 && !rows[0].required ? undefined : rows[0]?.summary ?? null;
    },
    async verifyRecipient(target) {
      const c = await readRecord<Credential>(client, `credential:${target.subject}`);
      if (!c || c.issuer !== internalIssuer(c.tenantId) || c.email.toLowerCase() !== target.email.toLowerCase()) return 'changed';
      try {
        const p = await assertActiveCredential(client, c);
        return p.app_user_id === target.user_id ? 'verified' : 'changed';
      } catch (error) { if (error instanceof InternalAuthError) return 'changed'; return 'unavailable'; }
    },
    async start(id, token, target) {
      // Drizzle configures this shared client's JSON serializers for pre-serialized values. The
      // standalone private email agent has different client options, so its sql.json is not portable.
      return (await client`select app.internal_auth_notification_start(${id}::uuid,${token}::uuid,${origin},${JSON.stringify(target)}::jsonb) started`)[0]?.started === true;
    },
    async finish(id, token, outcome, error) {
      return (await client`select app.internal_auth_notification_finish(${id}::uuid,${token}::uuid,${outcome},${error}) finished`)[0]?.finished === true;
    },
    async send(target, mail) { const message = workflowEmailMessage(mail); await sendInternalMail({ to: target.email, subject: message.subject, text: message.text }, transport); },
  });
  return await service(input) as T;
}
