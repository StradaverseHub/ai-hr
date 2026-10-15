import {z} from 'zod';

export const accountEmailKinds=['invitation','recovery'] as const;
export const accountEmailErrors=['relayUnavailable','providerUnavailable','notEligible','uncertain'] as const;
export type AccountEmailError=typeof accountEmailErrors[number];
export type AccountEmailReadiness='relayUnavailable'|'providerUnavailable'|null;
export type AccountEmailContext={deliveryId:string;leaseToken:string};
export type AccountEmailProvider={
  sendInvitation(email:string,activationPath?:string,context?:AccountEmailContext):Promise<{invitationId:string}>;
  sendPasswordReset(email:string,context?:AccountEmailContext):Promise<void>;
  /** Injected providers may omit this; the deployed provider always checks the managed relay. */
  emailReadiness?():Promise<AccountEmailReadiness>;
};
export const recoveryEmailSchema=z.email().max(320).regex(/^[\x21-\x7e]+$/).transform(email=>email.toLowerCase());
export class AccountEmailDeliveryError extends Error{
  constructor(public readonly code:AccountEmailError){super(`Account email: ${code}`);}
}
export type AccountEmailDeliveryView={id:string;kind:'invitation'|'recovery';email:string;status:'pending'|'sent'|'failed'|'skipped';attempts:number;error:AccountEmailError|null;createdAt:Date;canRetry:boolean};
