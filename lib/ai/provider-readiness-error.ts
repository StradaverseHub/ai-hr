/** Closed provider-evaluation refusal. Its message is fixed; `code` and the optional protocol detail are
 * code-owned names only. The detail's original refusal is non-enumerable and is classified by type, never
 * by message (error constructors are not a disclosure boundary). */
import type {ProviderProtocolOrigin,ProviderProtocolStage} from './provider-protocol';
export type AiProviderReadinessCode='consent_required'|'candidate_required'|'probe_failed'|'receipt_required'|'unavailable';
export type AiProviderReadinessDetail=Readonly<{stage:ProviderProtocolStage|'summary';origin:ProviderProtocolOrigin|'local';model:string|null;refusal?:unknown}>;
export class AiProviderReadinessError extends Error {
  declare readonly detail?: AiProviderReadinessDetail;
  constructor(readonly code: AiProviderReadinessCode, detail?: AiProviderReadinessDetail) {
    super('The AI provider evaluation could not be confirmed.'); this.name = 'AiProviderReadinessError';
    if (detail) {
      const {refusal,...visible}=detail,captured={...visible};
      Object.defineProperty(captured,'refusal',{value:refusal,enumerable:false});
      Object.defineProperty(this,'detail',{value:Object.freeze(captured),enumerable:false});
    }
  }
}
