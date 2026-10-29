import { z } from 'zod';
import type { Document, Mail } from './lifecycle-v9-model';
import type { NotificationEmailError, NotificationEmailOutcome } from './notification-email-model';
/** Only durable IDs and a one-attempt capability cross the authentication boundary. */
export const lifecycleV9DeliveryRequest = z.object({ deliveryId: z.uuid(), leaseToken: z.uuid() }).strict();
export type LifecycleV9DeliveryRequest = z.infer<typeof lifecycleV9DeliveryRequest>;
export type LifecycleV9DeliveryResult = { outcome: NotificationEmailOutcome; error: NotificationEmailError | null };
export type LifecycleV9MailTarget = {
  id: string; tenantId: string; companyId: string; caseId: string;
  payload: { version: 1; number: string; mail: Mail; documents: Document[]; files: { id: string; storageId: string; name: string; contentHash: string }[]; subject: { personId: string | null; employmentId: string | null } };
  contact?: { kind: 'onboardingContact'; email: string; caseId: string; sourceRevision: string } | null;
  literals?: { key: string; email: string; position: number }[];
  bindings: { userId: string; subject: string; issuer: string }[];
};
