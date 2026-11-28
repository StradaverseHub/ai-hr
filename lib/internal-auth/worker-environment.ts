/** The import worker (aihr-bank-import.service) runs "By Batch Send Invitation" (core/account-invitation-batch-job.ts)
 * and reads only its own protected /etc/aihr/import-worker.env, never the web runtime environment. Without the web
 * process's exact internal-auth settings it does not select embedded login (ADR-0117), so account email readiness
 * falls back to the legacy Keycloak relay socket, which internal installations never install, and every invitation
 * fails with "The email service is not available" (staging, 28 November 2026). The settings it needs:
 *  - AUTH_PROVIDER=internal: route account email through the HR-owned SMTP settings in the database;
 *  - AUTH_PUBLIC_ORIGIN: the invitation link's origin;
 *  - AUTH_SESSION_KEY: opens the encrypted SMTP settings and organisation records (a different key opens nothing).
 * Values never appear in a message. */
import {internalReady,internalSelected} from './config';

type Env=Record<string,string|undefined>;
export const WORKER_INTERNAL_AUTH_KEYS=['AUTH_PROVIDER','AUTH_PUBLIC_ORIGIN','AUTH_SESSION_KEY'] as const;

/** null when the worker can send account email through embedded login; otherwise the startup warning. */
export function workerInternalAuthWarning(env:Env=process.env):string|null{
 if(internalSelected(env)&&internalReady(env))return null;
 return `Import worker: ${WORKER_INTERNAL_AUTH_KEYS.join('/')} are missing or invalid in its environment. `+
  'Batch account invitations will fail with "The email service is not available" until the web process values are copied into /etc/aihr/import-worker.env '+
  '(deploy/internal-auth/WORKER-ACCOUNT-EMAIL.md).';
}
