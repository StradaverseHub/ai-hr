/** Server-only routing context supplied by the Notifications consent owner. No address or transport proof is client input. */
import type { SessionContext } from '../db/client';
export type MasterRecipientIdentity={userId:string;employmentId:string};
/** Compare every field exactly immediately before SMTP. Sequence alone cannot detect withdrawal/re-enable without an intervening event. Timestamp strings preserve PostgreSQL microseconds (UTC ISO with six fractional digits); never round through JavaScript Date. */
export type MasterConsentRevision={consentAfterSequence:number;policyAfterSequence:number;consentUpdatedAt:string;policyUpdatedAt:string;consentVerifiedAt:string};
export type MasterRecipient=MasterRecipientIdentity&MasterConsentRevision&{label:string;context:SessionContext;scopeIds:string[]};
export type MasterRecipientPolicy=(ctx:SessionContext)=>Promise<readonly MasterRecipient[]>;
