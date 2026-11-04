/** Account admission is independent of password/MFA state; expiry is inclusive in the HR calendar. */
import {todayInKualaLumpur} from '../hr-date';
import type {Credential} from './credential';
export function accountAvailable(c:Pick<Credential,'enabled'|'suspended'|'accountActiveUntil'>,now=new Date()) {
 return c.enabled && !c.suspended && (!c.accountActiveUntil || c.accountActiveUntil>=todayInKualaLumpur(now));
}
export function temporaryPasswordAvailable(c:Pick<Credential,'temporaryPasswordExpiresAt'>,now=Date.now()) {
 return c.temporaryPasswordExpiresAt===undefined || c.temporaryPasswordExpiresAt>now;
}
export type RecoveryExemption={purpose:'password-reset';expiresAt:number;reason:string};
