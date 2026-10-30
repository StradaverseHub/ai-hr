import {ProviderWorkloadUnavailableError} from '../../../lib/ai/provider-workload-policy';
import {AiPrivacyGateError} from '../../../lib/ai/provider-privacy-request';
/** The ONE place a Performance AI action turns a caught error into text for its user.
 * A typed AI control refusal (feature paused, allowance reached, or a configured USD spend control: see
 * core/ai-spend-capability AiSpendControlError) becomes the product's existing translated AI refusal,
 * messages/*.json assistant.err_ai_control: the same sentence the Assistant shows for the same refusal.
 * Everything else keeps the r388 redaction (lib/public-error). Neither path returns SQL, provider, amount,
 * scope or record detail, and the control sentence never confirms that any hidden record exists. */
import {AiAllowanceError} from '../../../lib/ai/types';
import {publicErrorMessage} from '../../../lib/public-error';
export const AI_CONTROL_REFUSAL_KEY='err_ai_control' as const;
export async function performanceAiErrorMessage(error:unknown,translate:(key:typeof AI_CONTROL_REFUSAL_KEY|'err_protected_input')=>string|Promise<string>):Promise<string>{
 if(error instanceof ProviderWorkloadUnavailableError||error instanceof AiPrivacyGateError)return translate('err_protected_input');
 if(error instanceof AiAllowanceError)return translate(AI_CONTROL_REFUSAL_KEY);
 return publicErrorMessage(error);
}
