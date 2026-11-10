/** Security history labels (accountManagement.historyEvent.*). Client-safe; no secret ever reaches here. */
const LABELS:Record<string,string>={
 'app-user.account-suspend':'suspended',
 'app-user.account-reactivate':'reactivated',
 'app-user.account-expiry':'expiryChanged',
 'app-user.account-expired':'accountExpired',
 'app-user.account-temporary-password':'temporaryPassword',
 'app-user.account-reset-email':'resetEmail',
 'app-user.account-recovery-exemption':'paused',
 'app-user.account-recovery-exemption-cancelled':'resumed',
 'app-user.recovery-exemption-consumed':'consumed',
 'app-user.recovery-exemption-expired':'pauseExpired',
 'app-user.logged-in':'signedIn',
 'app-user.password-reset':'passwordChanged',
 'app-user.mfa-enrolled':'authenticatorEnrolled',
 'app-user.password-unlocked':'unlocked',
};
export function historyLabelKey(eventType:string){return LABELS[eventType]??'other';}
/** Events an administrator performs; the history names that administrator. Others are the person's own or the system's. */
export function historyShowsActor(eventType:string){return eventType.startsWith('app-user.account-')||eventType==='app-user.password-unlocked';}
