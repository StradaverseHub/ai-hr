/** Closed public refusal type shared by review, admission and UI; no configuration or source values. */
import {AiGatewayError} from './types';
export class AiPrivacyGateError extends AiGatewayError{
 constructor(readonly reason:'unreviewed'|'unsupported'|'small_cohort'|'source'='unreviewed'){super(reason==='unreviewed'?'This AI request needs a reviewed data-protection policy. You can continue using the application directly.':reason==='small_cohort'?'There is not enough grouped data for a protected AI analysis.':'This request needs protected input. You can continue using the application directly.');this.name='AiPrivacyGateError';}
}
