import { sql } from 'drizzle-orm';
import { redirect } from 'next/navigation';
import { withTenant, type SessionContext } from '@/db/client';
import { getSession } from '@/lib/session';
import { keycloakSelected } from './config';
import { currentIdentitySession } from './session';
import { identityEmailRequest } from './email-ipc';
import { EmailSettingsError, type EmailSettingsView, type IdentityEmailActor } from './email-model';
export async function canConfigureIdentityEmail(ctx: SessionContext): Promise<boolean> {
  if(!keycloakSelected() || !ctx.userId) return false;
  return withTenant(ctx,async tx=>{const result=await tx.execute(sql`select app.is_identity_email_operator() as allowed`) as unknown as {allowed:boolean}[];return result[0]?.allowed===true;});
}
export async function requireIdentityEmailAdmin(): Promise<{session:SessionContext;actor:IdentityEmailActor}> {
  const session=await getSession();
  if(!await canConfigureIdentityEmail(session)) redirect('/');
  const identity=await currentIdentitySession();
  if(!identity?.emailVerified || !session.userId) throw new EmailSettingsError('forbidden');
  return {session,actor:{userId:session.userId,tenantId:session.tenantId,issuer:identity.issuer,subject:identity.subject}};
}
export async function readIdentityEmailSettings(actor: IdentityEmailActor) {
  return identityEmailRequest<EmailSettingsView>({op:'view',actor});
}
