/** Account admission is independent of password/MFA state; expiry is inclusive in the HR calendar. */
import {todayInKualaLumpur} from '../hr-date';
import type {Credential} from './credential';
export function accountAvailable(c:Pick<Credential,'enabled'|'suspended'|'accountActiveUntil'>,now=new Date()) {
 return c.enabled && !c.suspended && (!c.accountActiveUntil || c.accountActiveUntil>=todayInKualaLumpur(now));
}
export function temporaryPasswordAvailable(c:Pick<Credential,'temporaryPasswordExpiresAt'>,now=Date.now()) {
 return c.temporaryPasswordExpiresAt===undefined || c.temporaryPasswordExpiresAt>now;
}
/** An administrator's single-use pause of the existing authenticator check (ADR-0117 recovery exemption).
 * It never removes MFA: a consuming sign-in or reset retires the old factor and must enrol a new one. */
export type RecoveryExemption={purpose:'password-reset';expiresAt:number;reason:string};
export function recoveryExemptionActive(e:RecoveryExemption|null|undefined,now=Date.now()):e is RecoveryExemption {
 return e?.purpose==='password-reset'&&Number.isFinite(e.expiresAt)&&e.expiresAt>now;
}
