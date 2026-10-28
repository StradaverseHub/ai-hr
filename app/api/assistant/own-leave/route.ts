/** Candidate-only composition. Release requires the combined migration/security/experience gate.
 * No posted session, model executor or alternate effect path is introduced here. */
import {handleConfiguredOwnLeaveBrowserCommand} from '@/core/assistant-actions/own-leave-runtime';

export const runtime='nodejs';
export const dynamic='force-dynamic';
export const POST=handleConfiguredOwnLeaveBrowserCommand;
