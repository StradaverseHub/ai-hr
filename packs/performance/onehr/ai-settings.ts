import type { SessionContext, Tx } from '../../../db/client';
import { assertModuleEnabled, resolveEntitlementsTx, settingEnabled } from '../../../core/entitlements';
import { resolveActiveAiConfig } from '../../../core/ai-config';
import { setTenantSetting } from '../../../core/tenant-settings';
import { withPerformanceTenant } from '../../../core/module-gate';
import { isAdmin, isGroupAdmin } from '../../../lib/authz';

export const ASSESSMENT_AI_FEATURES = ['360', 'tc', 'pm', 'review', 'idp', 'calib'] as const;
export type AssessmentAiFeature = typeof ASSESSMENT_AI_FEATURES[number];

/** Resolve again after provider work: the request's entitlement snapshot may predate an HR switch. */
export async function assessmentAiSettingsTx(tx: Tx, ctx: SessionContext) {
  const fresh: SessionContext = { ...ctx, entitlements: await resolveEntitlementsTx(tx, ctx.tenantId), entitlementsExempt: undefined, entitlementsError: undefined };
  return {
    '360': settingEnabled(fresh, 'performance.ai_360_enabled'),
    tc: settingEnabled(fresh, 'performance.ai_tc_enabled'),
    pm: settingEnabled(fresh, 'performance.ai_pm_enabled'),
    review: settingEnabled(fresh, 'performance.ai_review_enabled'),
    idp: settingEnabled(fresh, 'performance.ai_idp_enabled'),
    calib: settingEnabled(fresh, 'performance.ai_calib_enabled'),
  };
}

export async function assessmentAiConfigTx(tx: Tx, ctx: SessionContext, feature: AssessmentAiFeature) {
  if (!(await assessmentAiSettingsTx(tx, ctx))[feature]) return null;
  return resolveActiveAiConfig(tx, ctx);
}

export async function assessmentAiStateTx(tx: Tx, ctx: SessionContext) {
  const switches = await assessmentAiSettingsTx(tx, ctx);
  let providerConfigured = false;
  try { providerConfigured = !!await resolveActiveAiConfig(tx, ctx); } catch { /* Manual forms remain available. */ }
  const features = { ...switches };
  for (const feature of ASSESSMENT_AI_FEATURES) features[feature] = switches[feature] && providerConfigured;
  return { switches, features, providerConfigured };
}

export async function getAssessmentAiSwitches(ctx: SessionContext) {
  if (!isAdmin(ctx)) throw Error('Only HR administrators may view assessment AI settings.');
  return withPerformanceTenant(ctx, async tx => ({ ...await assessmentAiStateTx(tx, ctx), mayWrite: isGroupAdmin(ctx) }));
}

export async function setAssessmentAiSwitch(ctx: SessionContext, feature: AssessmentAiFeature, on: boolean) {
  if (!ASSESSMENT_AI_FEATURES.includes(feature) || typeof on !== 'boolean') throw Error('Unknown assessment AI setting.');
  // The central writer owns group-wide authorization, RLS, provenance and the audit event.
  assertModuleEnabled(ctx, 'performance');
  await setTenantSetting(ctx, { key: `performance.ai_${feature}_enabled`, value: on });
}
