/** The agent modules the current caller can read through the Assistant: exactly the job modules the
 * workspace offers. Offering only — every read, choices list, prepare and confirm still re-checks on its
 * own server path, so this set can hide a proposal but never authorize one. */
import type {SessionContext} from '../db/client';
import {MODULE_JOBS} from '../lib/ai/module-jobs';
import type {AgentModuleCode} from '../lib/ai/module-agents';
import {isAdmin} from '../lib/authz-model';
import {isModuleEnabled} from './entitlements';
export function assistantReadableModules(ctx:SessionContext):AgentModuleCode[]{
 return MODULE_JOBS.filter(([code])=>isModuleEnabled(ctx,code)&&(code!=='system_explorer'||isAdmin(ctx))).map(([code])=>code);
}
