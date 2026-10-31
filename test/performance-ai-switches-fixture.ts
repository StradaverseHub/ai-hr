import * as schema from '../db/schema';
import { owner } from './harness';

/** The six `performance.ai_*_enabled` switches (lib/ai/features.ts performance_* settings). */
export const PERFORMANCE_AI_SETTING_KEYS = ['360', 'tc', 'pm', 'review', 'idp', 'calib'].map(id => `performance.ai_${id}_enabled`);

/** Owner decision 3 (WP6): Performance AI switches default OFF. A suite that exercises assisted drafting opts in
 *  explicitly, as a group administrator would, with a stored customer value for each switch. */
export async function switchOnPerformanceAi(tenantId: string) {
  await owner.db.insert(schema.tenantSetting)
    .values(PERFORMANCE_AI_SETTING_KEYS.map(key => ({ tenantId, key, value: true, source: 'customer' as const })))
    .onConflictDoUpdate({ target: [schema.tenantSetting.tenantId, schema.tenantSetting.key], set: { value: true } });
}
