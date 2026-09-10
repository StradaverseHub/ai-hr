/**
 * ADR-0084 r243 — the switchboard for the unattended agents, and the app's first writer of
 * `tenant_setting`.
 *
 * The write is fenced by an RLS policy (0313's `tenant_setting_write`) whose failure mode is SILENCE: a
 * write that misses it matches zero rows, returns no error, and leaves the caller believing it saved. So
 * `setTenantSetting` re-states every conjunct of that policy in TypeScript and refuses with a typed
 * error, and these cases are what keep the two in step. A guard that only tested the happy path would
 * pass for a service that had quietly stopped fencing anything.
 *
 * The rest of the file pins the two claims the SCREEN makes that nothing else can check: that a switch
 * being on is not the same as the agent being able to act, and that no accuracy rate is rendered while
 * the ledger is empty.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { AI_AGENT_SETTINGS } from '../core/tenant-settings';
import { SETTING_CATALOG } from '../packs/catalog';
import en from '../messages/en.json';

const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const SERVICE = read('core/tenant-settings.ts');
const PAGE = read('app/control-tower/agents/page.tsx');
const ACTION = read('app/control-tower/agents/actions.ts');
const code = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

describe('the three agents this screen offers', () => {
  it('are all catalogued, tenant-scoped and customer-visible — the three things the policy demands', () => {
    expect(AI_AGENT_SETTINGS).toHaveLength(3);
    for (const a of AI_AGENT_SETTINGS) {
      const entry = SETTING_CATALOG.find((s) => s.key === a.key);
      expect(entry, `${a.key} is not in SETTING_CATALOG`).toBeDefined();
      expect(entry!.scope, `${a.key} scope`).toBe('tenant');
      expect(entry!.customerVisible, `${a.key} customerVisible`).toBe(true);
      expect(entry!.valueType, `${a.key} valueType`).toBe('boolean');
      // Off by default, every one. A switchboard that could arrive with an unattended agent already
      // running would defeat the point of there being a switch.
      expect(entry!.defaultValue, `${a.key} defaultValue`).toBe(false);
      expect(entry!.defaultOnInstall, `${a.key} defaultOnInstall`).toBe(false);
    }
  });

  it('each reads its own value through a STRING LITERAL key', () => {
    // test/module-catalog-drift.test.ts scans every settingEnabled call outside core/entitlements.ts for
    // a literal, and fails on a variable — because a variable key is invisible to the catalogue check,
    // which is what would let an uncatalogued key through (a 500, not a disabled feature). This case
    // caught nothing new; it exists so the NEXT person, reading `key` right beside `read`, does not
    // "tidy away" the duplication. It bit r237 on the nudge's own call site and it bit r243 here.
    for (const a of AI_AGENT_SETTINGS) {
      expect(SERVICE, `${a.id} must read its setting through the literal '${a.key}'`).toContain(
        `settingEnabled(ctx, '${a.key}')`,
      );
    }
    expect(code(SERVICE).includes('settingEnabled(ctx, a.key)'), 'never through the variable').toBe(false);
  });

  it('offers ONLY the unattended agents — not the payroll risk switches, not operator tooling', () => {
    const offered = AI_AGENT_SETTINGS.map((a) => a.key);
    // These two reopen or unlock a finalised payroll run. They are tenant-scoped and customer-visible,
    // so nothing but this list keeps them off a screen about the AI loop.
    expect(offered).not.toContain('payroll.reset_enabled');
    expect(offered).not.toContain('payroll.unlock_enabled');
    // Operator tooling, and platform-scoped besides.
    expect(offered).not.toContain('feedback.ai_planning_enabled');
  });
});

describe('the write re-states the policy rather than leaning on it', () => {
  /**
   * ⚠️ EACH OF THESE IS A CONJUNCT OF `tenant_setting_write` IN 0313. Losing one does not produce an
   * error — it produces an UPDATE that matches nothing, and a caller that says "saved".
   */
  it('refuses anything the policy would silently drop', () => {
    const c = code(SERVICE);
    expect(c, 'group admin — mirrors app.is_group_admin()').toContain("if (!isGroupAdmin(ctx)) throw new TenantSettingError('not_group_admin')");
    expect(c, 'the key must be catalogued').toContain("if (!entry) throw new TenantSettingError('unknown_key')");
    expect(c, "and tenant-scoped — the policy's EXISTS clause").toContain("entry.scope !== 'tenant'");
    expect(c, 'customer-visible, which the policy does not check and the product must').toContain('!entry.customerVisible');
    // r261 widened the writer to the `json` value type the catalog and 0313's CHECK have always
    // carried (board item 9583deac stores a list of field keys), so the conjunct is now spelled through
    // `settingValueType` — which answers 'json' for an array and `typeof` for everything else. The
    // assertion follows the line rather than being dropped: what matters is that the DECLARED TYPE is
    // still checked in TypeScript before the policy has to catch it silently.
    expect(c, 'and the declared value type').toContain('settingValueType(p.value) !== entry.valueType');
    expect(c, "…answering 'json' only for a list, never for an arbitrary object").toContain(
      "return Array.isArray(v) ? 'json' : typeof v;",
    );
  });

  it("writes source 'customer', on insert AND on update", () => {
    // 0313: provenance follows the write. A customer switch that left `platform` on the row would be
    // claiming the platform made the change — and overwriting a platform value REQUIRES setting it.
    const c = code(SERVICE);
    expect(c.match(/source: 'customer'/g) ?? [], 'both arms of the upsert').toHaveLength(2);
    expect(c, 'platform is never written from here').not.toContain("source: 'platform'");
  });

  it('records WHO changed it, because switching an agent on is an operational act', () => {
    expect(code(SERVICE)).toContain("eventType: 'tenant-setting.changed'");
    expect(code(SERVICE)).toContain('actor: actorOf(ctx)');
  });

  it('the action takes an AGENT ID, never a settings key, from the form', () => {
    // ⚠️ A form field naming a key would let anyone who can open this screen write ANY tenant-scoped
    // catalogued setting — including the two that reopen a finalised payroll run.
    const c = code(ACTION);
    expect(c).toContain("formData.get('agentId')");
    expect(c, 'the key comes from the closed list, not the request').toContain('AI_AGENT_SETTINGS.find((a) => a.id === id)');
    expect(c.includes("formData.get('key')"), 'the key must never be posted').toBe(false);
  });
});

describe('what the screen refuses to let an admin believe', () => {
  it('distinguishes ON from ABLE TO RUN, and names the shut gate', () => {
    // The state production has been in for three rounds: switched on and inert, with nothing saying so.
    expect(code(SERVICE), 'effective is on AND the gates').toContain('effective: on && moduleHeld && !providerMissing');
    const p = code(PAGE);
    expect(p, 'three states rendered, not two').toContain("a.effective ? t('stateOn') : a.on ? t('stateBlocked') : t('stateOff')");
    expect(p, 'and the reason when it cannot act').toContain("!a.moduleHeld ? t('blockedModule'");
    expect(p).toContain("t('blockedProvider')");
  });

  it('prints NO accuracy rate while the ledger is empty', () => {
    // ADR-0084 §2.3: every rate is null when its denominator is zero, and a screen must render that as
    // "not measured yet", never as a zero. The cheapest way to keep that true is to render no rate here
    // at all — this case fails the moment somebody wires one in without deciding how nulls read.
    const p = code(PAGE);
    for (const banned of ['proposalRates', 'agreementRate', 'adjudicationPassRate', 'reversalRate']) {
      expect(p.includes(banned), `${banned} needs a null story before it can be rendered here`).toBe(false);
    }
  });

  it('a read-only admin is told the switch is not theirs, rather than handed one that fails', () => {
    const p = code(PAGE);
    expect(p).toContain('const mayWrite = isGroupAdmin(s)');
    expect(p).toContain("{!mayWrite && (");
    expect(p, 'the form is only rendered to somebody who may use it').toContain('{mayWrite ? (');
  });
});

describe('the strings the screen resolves dynamically', () => {
  /**
   * The page renders `agent.${a.id}`, `agentDoes.${a.id}` and `refused.${reason}` as DYNAMIC keys, which
   * the i18n coverage checker cannot see. A missing one throws MISSING_MESSAGE and crashes the screen —
   * clean tsc, clean build, 200 on every other page (AGENTS 6).
   */
  it('exist for every agent and every refusal reason', () => {
    const a = en.payroll.controlTower.agents as unknown as Record<string, Record<string, string>>;
    for (const agent of AI_AGENT_SETTINGS) {
      expect(a.agent[agent.id], `agent.${agent.id}`).toBeTruthy();
      expect(a.agentDoes[agent.id], `agentDoes.${agent.id}`).toBeTruthy();
    }
    // Read the reasons back out of the service's own union so a new one cannot be added silently.
    const union = SERVICE.slice(SERVICE.indexOf('public readonly reason:'), SERVICE.indexOf(')', SERVICE.indexOf('public readonly reason:')));
    const reasons = [...union.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]!);
    expect(reasons.length, `reasons found: ${reasons.join(', ')}`).toBeGreaterThanOrEqual(5);
    for (const r of reasons) expect((a.refused as Record<string, string>)[r], `refused.${r}`).toBeTruthy();
  });
});
