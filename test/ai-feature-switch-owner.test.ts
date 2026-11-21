/** WP6 / R10 (D7): one switch owner per AI feature, read by SQL from one table; Performance AI defaults OFF;
 *  the OneHR per-field quota keeps one limit value. Static source checks; the DB behaviour is in
 *  test/ai-feature-switch-owner-db.test.ts. */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { AI_FEATURES } from '../lib/ai/features';
import { SETTING_CATALOG } from '../packs/catalog';
import { assessmentAiDailyLimit } from '../packs/performance/onehr/ai-usage';

const read = (p: string) => readFileSync(p, 'utf8');
const MIGRATION = 'db/migrations/0812_ai_feature_switch_owner.sql';
const journal: string[] = JSON.parse(read('db/migrations/meta/_journal.json')).entries.map((e: { tag: string }) => `db/migrations/${e.tag}.sql`);
/** The live definition of a SQL function is its LAST definition in journal (apply) order. */
const live = (marker: string) => {
  // Ownership ALTER statements also name functions; only CREATE definitions own bodies.
  const escaped = marker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const definitions = journal.flatMap(file => {
    const src = read(file);
    const pattern = new RegExp(String.raw`(?:^|\n)[\t ]*CREATE(?:\s+OR\s+REPLACE)?\s+` + escaped, 'g');
    return [...src.matchAll(pattern)].map(match => ({file, src, at: match.index + match[0].lastIndexOf(marker)}));
  });
  expect(definitions.length, marker).toBeGreaterThan(0);
  // Bodies may use any dollar-quote tag ($$, $facts$, …); the body ends at the next occurrence of its own tag.
  const {file, src, at} = definitions.at(-1)!, quote = /\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/g;
  quote.lastIndex = at; const open = quote.exec(src);
  expect(open, marker).not.toBeNull();
  const end = src.indexOf(open![0], open!.index + open![0].length);
  expect(at).toBeGreaterThanOrEqual(0); expect(end).toBeGreaterThan(open!.index);
  return {file, body: src.slice(at, end)};
};
/** The original installed wrapper is an independent byte oracle, not the final filename. */
const centreWrapper = (marker:string) => {
  const src=read('db/migrations/3200_ai_centre_controls.sql'),at=src.indexOf('CREATE '+marker);
  expect(at,marker).toBeGreaterThanOrEqual(0);
  const start=at+'CREATE '.length,end=src.indexOf('$$;',src.indexOf('$$',start)+2);
  expect(end).toBeGreaterThan(start);return src.slice(start,end);
};
const seed = () => journal.flatMap(file=>{
  const inserts=[...read(file).matchAll(/INSERT INTO app\.ai_feature_setting\(feature_id,setting_key\) VALUES([\s\S]*?);/g)];
  return inserts.flatMap(insert=>[...insert[1].matchAll(/\('([^']+)','([^']+)'\)/g)].map(m=>[m[1],m[2]] as const));
});
const settingBacked = AI_FEATURES.flatMap(f => f.setting === null ? [] : [[f.id, f.setting] as const]);
const sorted = (rows: readonly (readonly [string, string])[]) => rows.map(r => r.join('=')).sort();
const PERFORMANCE_KEYS = ['360', 'tc', 'pm', 'review', 'idp', 'calib'].map(id => `performance.ai_${id}_enabled`);

describe('one switch owner per AI feature (0692)', () => {
  it('seeds exactly the AI_FEATURES setting map, in both directions, including feedback_planning', () => {
    const rows = seed();
    expect(rows.length).toBe(settingBacked.length);
    expect(rows.length).toBeGreaterThanOrEqual(10);
    expect(sorted(rows)).toEqual(sorted(settingBacked));
    expect(new Set(rows.map(r => r[0])).size).toBe(rows.length);
    expect(rows).toContainEqual(['feedback_planning', 'feedback.ai_planning_enabled']);
    for (const [, key] of rows) expect(SETTING_CATALOG.some(s => s.key === key && s.valueType === 'boolean'), key).toBe(true);
  });

  it('reads the live switch key from the table, with no hard-coded CASE left', () => {
    const purpose = live('FUNCTION app._ai_control_context_for_purpose(');
    // 4338 keeps the ai-control lock in the purpose function and moves its policy reads into one facts owner.
    expect(purpose.body).toContain('FROM app._ai_control_context_policy_facts(wanted_feature,forced_pause,pause_only) f');
    expect(purpose.body).toContain("PERFORM pg_advisory_xact_lock_shared(hashtext('ai-control'),hashtext(tid::text))");
    expect(purpose.body).toContain("ELSE PERFORM pg_advisory_xact_lock(hashtext('ai-control'),hashtext(tid::text))");
    expect(purpose.body).not.toContain('SELECT s.setting_key');
    const context = live('FUNCTION app._ai_control_context_policy_facts(');
    expect(context.body).toContain('feature_paused:=coalesce(forced_pause,false) OR EXISTS(SELECT 1 FROM public.teras_mandate_control c WHERE c.tenant_id=tid AND c.stopped)');
    const pause=live('FUNCTION app.ai_action_unpaused(').body;
    // The installed centre stop wrapper must survive later pause-discovery optimisation.
    const beforeCentre=live('FUNCTION app._ai_control_context_before_centre(').body;
    expect(beforeCentre).toContain('RETURN QUERY SELECT * FROM app._ai_control_context_for_purpose(wanted_feature,forced_pause,false)');
    expect(pause).toContain('app._ai_control_context_for_purpose(wanted_feature,forced_pause,true)');
    const wrapper = live('FUNCTION app._ai_control_context(');
    expect(wrapper.body).toBe(centreWrapper('FUNCTION app._ai_control_context('));
    expect(live('FUNCTION app.ai_agent_action_unpaused(').body).toBe(centreWrapper('FUNCTION app.ai_agent_action_unpaused('));
    expect(read('db/migrations/3200_ai_centre_controls.sql')).toContain('ALTER FUNCTION app._ai_control_context(text,boolean) RENAME TO _ai_control_context_before_centre;');
    const compatibility=read(wrapper.file);
    expect(compatibility).toContain("'app._ai_control_context_before_centre(text,boolean)','a9ea819594d4adbde182910b573287da'");
    expect(compatibility).toContain("'app.ai_agent_action_unpaused_before_centre(text)','a1ae73ad6d4f47b598df29412507bccb'");
    expect(compatibility).toContain("p.proowner<>control_owner");
    expect(compatibility).toContain("a.grantor<>p.proowner OR a.is_grantable");
    expect(wrapper.body).toContain('FROM app._ai_control_context_before_centre(wanted_feature,forced_pause) c');
    expect(wrapper.body).toContain('c.feature_paused OR EXISTS(SELECT 1 FROM public.teras_mandate_control t WHERE t.tenant_id=app.current_tenant_id() AND t.stopped)');
    expect(wrapper.body).not.toContain('SELECT s.setting_key');
    for (const body of [purpose.body, context.body]) {
      expect(body).not.toMatch(/CASE\s+wanted_feature/);
      for (const [, key] of settingBacked) expect(body).not.toContain(`'${key}'`);
    }
    expect(context.body).toContain('SELECT s.setting_key INTO switch_key FROM app.ai_feature_setting s WHERE s.feature_id=wanted_feature');
    // A `feature:` row pauses only a settingless feature; the setting is the switch for the others.
    expect(context.body).toContain("IF switch_key IS NULL AND EXISTS(SELECT 1 FROM ai_control_policy p WHERE p.tenant_id=tid AND p.kind='feature'");
    const applicable = live('FUNCTION app._ai_applicable_policies(');
    expect(applicable.file).toBe(MIGRATION);
    expect(applicable.body).toContain("p.kind='feature' AND p.feature_id=wanted_feature AND NOT EXISTS(SELECT 1 FROM app.ai_feature_setting s WHERE s.feature_id=p.feature_id)");
    const guard = live('FUNCTION app.ai_control_policy_guard()');
    expect(guard.file).toBe(MIGRATION);
    expect(guard.body).toContain("THEN RAISE EXCEPTION 'Setting-controlled AI feature'");
  });

  it('keeps the reference table read-only to the application role', () => {
    const src = read(MIGRATION);
    expect(src).toContain('ALTER TABLE app.ai_feature_setting ENABLE ROW LEVEL SECURITY;');
    expect(src).toContain('REVOKE ALL ON app.ai_feature_setting FROM PUBLIC,ai_hr_app;');
    expect(src).toContain('GRANT SELECT ON app.ai_feature_setting TO ai_hr_app;');
    expect(src).not.toMatch(/GRANT\s+(?:INSERT|UPDATE|DELETE|ALL)[^;]*ai_feature_setting/i);
  });
});

describe('Performance AI switches default OFF (owner decision 3)', () => {
  it('ships all six off, at install too, and aligns the stored setting_definition default', () => {
    const perf = SETTING_CATALOG.filter(s => /^performance\.ai_[a-z0-9]+_enabled$/.test(s.key));
    expect(perf.map(s => s.key).sort()).toEqual([...PERFORMANCE_KEYS].sort());
    expect(AI_FEATURES.filter(f => f.module === 'performance' && f.setting).map(f => f.setting).sort()).toEqual([...PERFORMANCE_KEYS].sort());
    for (const s of perf) { expect(s.defaultValue, s.key).toBe(false); expect(s.defaultOnInstall, s.key).toBe(false); }
    const update = read(MIGRATION).match(/UPDATE setting_definition SET default_value='false'::jsonb,default_on_install='false'::jsonb\s+WHERE key IN \(([^)]+)\);/);
    expect(update).not.toBeNull();
    expect([...update![1].matchAll(/'([^']+)'/g)].map(m => m[1]).sort()).toEqual([...PERFORMANCE_KEYS].sort());
  });

  it('keeps boolean defaults off except the explicit operator-owned Feedback menu', () => {
    const booleans = SETTING_CATALOG.filter(s => s.valueType === 'boolean');
    expect(booleans.length).toBeGreaterThan(6);
    // Native0696 deliberately preserves the existing menu when no operator row exists. This
    // presentation switch is not AI admission and does not opt any Performance AI feature in.
    expect(booleans.filter(s => s.defaultValue !== false).map(s => s.key)).toEqual(['feedback.menu_enabled']);
    expect(booleans.find(s => s.key === 'feedback.menu_enabled')).toMatchObject({
      moduleCode:null,scope:'platform',valueType:'boolean',defaultValue:true,defaultOnInstall:null,customerVisible:false,
    });
    expect(settingBacked.map(([,key])=>key)).not.toContain('feedback.menu_enabled');
    const menuOwner=read('db/migrations/0696_feedback_menu_operator_switch.sql');
    expect(menuOwner).toContain("RETURN coalesce(result,true);");
    expect(menuOwner).toContain("'feedback.menu_enabled',NULL,'platform','boolean','true'::jsonb,NULL,false");
    for (const file of ['core/entitlements.ts', 'core/entitlement-types.ts']) expect(read(file)).not.toMatch(/performance AI switches default true/);
  });
});

describe('OneHR per-field draft quota keeps one limit value beside ai_admit', () => {
  it('uses the same daily limit in the service, its refusal text and the enforcing trigger', () => {
    expect(assessmentAiDailyLimit).toBe(5);
    const trigger = live('FUNCTION app.assessment_ai_use_validate() RETURNS').body;
    const enforced = trigger.match(/\)>=(\d+) THEN RAISE EXCEPTION 'All (\d+) AI suggestions/);
    expect(enforced).not.toBeNull();
    expect(Number(enforced![1])).toBe(assessmentAiDailyLimit);
    expect(Number(enforced![2])).toBe(assessmentAiDailyLimit);
    const narrative = read('packs/performance/onehr/ai.ts').match(/All (\d+) AI drafts for this field/);
    expect(Number(narrative?.[1])).toBe(assessmentAiDailyLimit);
  });

  it('keeps kernel admission free of the Performance business ledger', () => {
    // ai_admit owns provider-call allowances (every admitted call, per scope); the per-field quota counts only
    // successful, adjudicated drafts per actor and field (packs/performance/onehr/ai-usage.ts). See the WP6 PR.
    const admit = live('FUNCTION app.ai_admit(').body;
    expect(admit).toContain('app._ai_control_context(wanted_feature,');
    expect(admit).not.toContain('performance_assessment_ai_use');
  });
});
