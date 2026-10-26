import { describe, expect, it } from 'vitest';
import { aiCustodyResetRefusal, AI_CUSTODY_RESET_REFUSAL } from '../db/seed-ai-custody-guard';
import { DEMO_TENANT_ID, SYSTEM_TENANT_ID } from '../db/seed-guard';

describe('AI custody destructive demo-reset refusal', () => {
  it('allows the empty application bootstrap and exact reserved system tenant only', () => {
    expect(aiCustodyResetRefusal(true, [])).toBeNull();
    expect(aiCustodyResetRefusal(true, [SYSTEM_TENANT_ID])).toBeNull();
    expect(aiCustodyResetRefusal(false, [DEMO_TENANT_ID])).toBeNull();
  });
  it('refuses the existing demo as well as any other application tenant without an override argument', () => {
    expect(aiCustodyResetRefusal(true, [SYSTEM_TENANT_ID, DEMO_TENANT_ID])).toBe(AI_CUSTODY_RESET_REFUSAL);
    expect(aiCustodyResetRefusal(true, ['22222222-2222-2222-2222-222222222222'])).toBe(AI_CUSTODY_RESET_REFUSAL);
  });
});
