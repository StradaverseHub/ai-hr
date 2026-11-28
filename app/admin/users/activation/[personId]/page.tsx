import Link from 'next/link';
import {notFound} from 'next/navigation';
import {getTranslations} from 'next-intl/server';
import {requireGroupAdministration} from '@/lib/security-center-authz';
import {readActivationPerson} from '@/core/account-activation';
import {formatDmyTime} from '@/lib/date-display';
import {btnGhost} from '@/components/ui';
import {revokeInvitationAction} from '../../../actions';
import {retryAccountEmailAction} from '../../../settings/notifications/actions';
import {ManualSubmit} from '../../manual-submit';
import {SecurityPageHeader} from '../../security-page';

/** Board 0735d1b7 — View/Edit for a Pending Activation row: a person with no login yet. Group administrators only (the
 * people who prepare logins). It offers only what fits: with no invitation, Set Username and Password and Send
 * Invitation; with an open invitation, when it was sent and whether the email went out, Resend and Revoke; with a
 * manual setup in progress, Resume. Every action keeps its existing page and owner (core/auth.ts, the manual setup).
 * Sending an invitation never activates an account. A person who is not an activation candidate is refused. */
export default async function ActivationPage({params}:{params:Promise<{personId:string}>}){
 const ctx=await requireGroupAdministration(),{personId}=await params;
 const person=await readActivationPerson(ctx,personId).catch(()=>null);if(!person)notFound();
 const [t,u,d]=await Promise.all([getTranslations('admin.users.activation'),getTranslations('admin.users'),getTranslations('admin.users.directory')]);
 const action=`${btnGhost.replace('h-9','min-h-11')} whitespace-normal`,invitation=person.invitation;
 const returnTo=`/admin/users/activation/${person.id}`;
 const kind=person.hasEmployment?'internal':'external';
 const info:[string,string][]=[[d('employeeName'),person.name],[d('employeeId'),person.employeeCode??'—'],[d('email'),person.email??'—'],[d('userTypeColumn'),d(`userTypeValue.${kind}`)],
  [d('accountStatus'),`${d('tier.pending')} · ${u(`status.${person.setupInProgress?'preparing':invitation?'invited':'pending'}`)}`]];
 return <div className="mx-auto w-full space-y-6"><SecurityPageHeader title={t('title',{name:person.name})}/>
  <section aria-labelledby="activation-information" className="space-y-3"><h2 id="activation-information" className="font-medium">{t('information')}</h2>
   <dl className="grid gap-4 rounded-lg border border-border p-5 sm:grid-cols-2 lg:grid-cols-3">{info.map(([label,value])=><div key={label}><dt className="text-sm text-muted-foreground">{label}</dt><dd className="break-words font-medium">{value}</dd></div>)}
    {person.profileEmploymentId&&<div className="sm:col-span-2 lg:col-span-3"><dt className="text-sm text-muted-foreground">{t('personnelProfile')}</dt><dd><Link href={`/admin/personnel/${person.profileEmploymentId}`} className="text-primary underline underline-offset-4">{t('openPersonnelProfile')}</Link></dd></div>}
   </dl></section>
  <section aria-labelledby="activation-actions" className="space-y-3"><h2 id="activation-actions" className="font-medium">{t('actions')}</h2>
   <p className="text-sm text-muted-foreground">{t('pendingNote')}</p>
   {person.setupInProgress?<div className="space-y-2"><p className="text-sm">{t('setupInProgress')}</p><Link href="/admin/users/create" className={action}>{u('resumeActivation')}</Link></div>
   :invitation?<div className="space-y-4 rounded-lg border border-border p-5">
     <dl className="grid gap-3 text-sm sm:grid-cols-2">
      <div><dt className="text-muted-foreground">{t('invitedEmail')}</dt><dd className="break-all">{invitation.email}</dd></div>
      <div><dt className="text-muted-foreground">{t('invitedRole')}</dt><dd>{u(`role.${invitation.role}`)}</dd></div>
      <div><dt className="text-muted-foreground">{t('invitationCreated')}</dt><dd className="tabular-nums">{formatDmyTime(invitation.createdAt)}</dd></div>
      <div><dt className="text-muted-foreground">{t('invitationExpires')}</dt><dd className="tabular-nums">{formatDmyTime(invitation.expiresAt)}</dd></div>
      <div className="sm:col-span-2"><dt className="text-muted-foreground">{t('emailStatus')}</dt><dd role={invitation.deliveryStatus==='failed'?'alert':undefined}>
       {invitation.deliveryStatus==='sent'&&invitation.deliverySentAt?t('sentAt',{at:formatDmyTime(invitation.deliverySentAt)}):t(`delivery.${invitation.deliveryStatus??'none'}`)}
       {invitation.deliveryStatus==='failed'&&invitation.deliveryError&&<span className="block text-xs text-muted-foreground">{t('deliveryError',{code:invitation.deliveryError})}</span>}</dd></div>
     </dl>
     <div className="flex flex-wrap gap-3">
      {invitation.deliveryId&&(invitation.deliveryStatus==='sent'||invitation.deliveryStatus==='failed')&&<form action={retryAccountEmailAction}><input type="hidden" name="deliveryId" value={invitation.deliveryId}/><input type="hidden" name="acknowledged" value="true"/><input type="hidden" name="kind" value="invitation"/><input type="hidden" name="returnTo" value={returnTo}/><ManualSubmit variant="outline">{t('resend')}</ManualSubmit></form>}
      <form action={revokeInvitationAction}><input type="hidden" name="invitationId" value={invitation.id}/><ManualSubmit variant="outline">{u('revokeInvitation')}</ManualSubmit></form>
     </div>
     <p className="text-xs text-muted-foreground">{t('resendHelp')}</p>
    </div>
   :<div className="flex flex-wrap gap-3">
     <Link href={`/admin/users/create?activate=${person.id}`} className={action}>{d('setUsernamePassword')}</Link>
     <Link href={`/admin/users/invite?activate=${person.id}`} className={action}>{d('sendInvitation')}</Link>
    </div>}
  </section>
 </div>;
}
