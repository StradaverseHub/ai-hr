/**
 * ADR-0082 slice 4 — THE ASSISTANT IS REACHABLE, AND ONLY BY THE PEOPLE IT SHOULD BE.
 *
 * Slices 1-3 shipped a gateway, a tool registry and a loop with no screen and no way to grant anyone
 * access: production carried ZERO grants and ZERO exchanges, so every line of it was unreachable. This
 * file pins the wiring that changes that, and the one live-vs-historic distinction it turns on.
 *
 * THE CASE THAT MATTERS MOST IS `listAssistantGrants` RETURNING REVOKED ROWS. Its own docblock says so —
 * "every grant ever, newest first — revoked rows included, because 'who could ask the assistant last
 * March' is the reason revocation is a stamp". A screen that reads that list as "who has access" shows a
 * revoked person as still granted and offers to revoke them twice. The Users screen filters on
 * `revokedAt == null`; this asserts the underlying distinction the filter depends on, so a future change
 * that made the list live-only (or that dropped the filter) cannot pass silently.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { adminCtx, closeAll, migrateTestDb, resetDb, seedBase, setModule, type Base } from './harness';
import { grantAssistant, listAssistantGrants, mayUseAssistant, revokeAssistant } from '../core/assistant-grant';

const ROOT = path.resolve(__dirname, '..');
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

describe('ADR-0082 slice 4 — the screen exists and is wired', () => {
  it('the route, its action, and the nav row all exist', () => {
    expect(fs.existsSync(path.join(ROOT, 'app/assistant/page.tsx'))).toBe(true);
    expect(fs.existsSync(path.join(ROOT, 'app/assistant/actions.ts'))).toBe(true);
    expect(read('components/sidebar.tsx')).toContain("href: '/assistant'");
  });

  it('the nav row is gated by the billable module', () => {
    // Without the MODULE_OF_HREF entry the rail would advertise a module the tenant has not bought.
    // `assistant` is packBacked: false, so — like system_explorer — there is no descriptor to derive it
    // from and the entry has to be written by hand, which is exactly why it needs a guard.
    expect(read('components/sidebar.tsx')).toContain("['/assistant', 'assistant'] as const");
  });

  it('is in the function-access matrix only as the conditional, layout-authenticated Assistant column', () => {
    // History: ADR-0082 slice 4 kept /assistant OUT of the matrix because the page used getSession and
    // the function-access guard regex knew no session guard (r225's trap). ADR-0131 ("Shared Assistant
    // page authentication and access reference") replaced that: app/assistant/layout.tsx authenticates
    // the workspace and every human review page through the selected browser session, and the matrix
    // carries ONE conditional `assistantSession` column covering exactly those routes
    // (test/function-access.test.ts pins the route set). Role eligibility there is not an Assistant
    // grant: the grant, module, pause and native permission remain with each reader or command.
    expect(read('app/assistant/page.tsx')).toContain('getSession');
    expect(read('app/assistant/layout.tsx')).toContain('await getBrowserCommandSession()');
    const permissions = read('lib/permissions.ts');
    expect(permissions).toContain("{screenKey:'assistantWorkspace',href:'/assistant',labelKey:'nav.assistant',guard:'assistantSession',");
    expect(permissions.match(/href:'\/assistant'/g) ?? []).toHaveLength(1);
    // Conditional, never an unconditional "accessible" claim for any role.
    expect(read('components/function-access-grid.tsx')).toContain("screen.guard==='assistantSession'");
  });

  it('the screen never renders an unexplained refusal', () => {
    // mayUseAssistant returns three distinct reasons; each has to reach the operator as its own sentence
    // naming who can fix it. A single "no access" would be a dead end.
    const page = read('app/assistant/page.tsx');
    expect(page).toContain('denied_');
    for (const reason of ['module_off', 'no_grant', 'no_user','unavailable']) {
      expect(read('messages/en.json')).toContain(`denied_${reason}`);
    }
  });

  it('renders deterministic canonical cards and fixed bridge copy, never raw stored model prose',()=>{
    const page=read('app/assistant/page.tsx');expect(page).not.toContain('{h.answer}');
    expect(page).toContain('CanonicalModuleJob');
    expect(page).toContain("from '@/components/assistant/workspace-conversation'");
    expect(page).toContain('<WorkspaceConversation');
    expect(page).toContain('fullHeight');
    expect(page).toContain('lg:grid-cols-[16rem_minmax(0,1fr)]');
    expect(page).toContain('<aside');
    expect(page).toContain('initialTurns={initialTurns}');
    expect(page).toContain('loadOwnAssistantChat');
    expect(page).toContain("from '@/components/assistant/exchange-reply'");
    expect(page).toContain('answer:<ExchangeReply exchange={exchange} ctx={s}/>');
    const reply=read('components/assistant/exchange-reply.tsx');
    expect(reply).toContain("import {GroundedWorkspaceReply} from './module-jobs'");
    expect(reply).toContain('h.grounded?<GroundedWorkspaceReply reply={h.grounded} ctx={ctx} exchangeId={h.id}/>');
    expect(reply).toContain("t('workspace.conversation.unavailable')");
    expect(reply).not.toContain('{h.answer}');
    const renderer=read('components/assistant/module-jobs.tsx');expect(renderer).toContain("t('grounded')");expect(renderer).toContain("'generic':'unavailable'");
    const source=read('core/ai-workspace.ts');expect(source).toContain('answer:null');
    expect(source).toContain('workspaceGroundedAnswers');
  });

  it('every stop reason and every error code has a localised sentence', () => {
    // §2.5: `stop` has FIVE members and only `end` means finished. An assistant that quietly stops
    // looking is indistinguishable from one that finished, so the four non-`end` outcomes each need
    // their own words — as does every AssistantError code the action can carry.
    const en = JSON.parse(read('messages/en.json')).assistant as Record<string, string>;
    for (const stop of ['refusal', 'max_tokens', 'other', 'tool_use']) {
      expect(en[`stop_${stop}`], `stop_${stop}`).toBeTruthy();
    }
    expect(en.stop_turn_cap).toBeTruthy();
    for (const code of ['not_configured', 'budget_monthly', 'budget_daily', 'invalid_question', 'provider_error', 'ai_control']) {
      expect(en[`err_${code}`], `err_${code}`).toBeTruthy();
    }
  });
});

describe('ADR-0082 — a revoked grant is not a live grant', () => {
  let base: Base;
  beforeAll(async () => {
    await migrateTestDb();
  });
  beforeEach(async () => {
    await resetDb();
    base = await seedBase();
    await setModule(base.tenantId, 'assistant', 'active');
  });
  afterAll(async () => {
    await closeAll();
  });

  it('listAssistantGrants KEEPS the revoked row, and mayUseAssistant still says no', async () => {
    const a = adminCtx(base);
    const appUserId = base.adminUserId;

    await grantAssistant(a, { appUserId });
    expect((await mayUseAssistant(a)).allowed).toBe(true);

    await revokeAssistant(a, { appUserId });

    // The access answer flips…
    const after = await mayUseAssistant(a);
    expect(after.allowed).toBe(false);
    expect(after.allowed === false && after.reason).toBe('no_grant');

    // …while the HISTORY deliberately does not lose the row. Both halves matter: the first is the gate,
    // the second is why a screen must filter rather than count.
    const all = await listAssistantGrants(a);
    const mine = all.filter((g) => g.appUserId === appUserId);
    expect(mine.length, 'the revoked grant is still listed').toBeGreaterThan(0);
    expect(mine.every((g) => g.revokedAt != null), 'and it is stamped revoked, not deleted').toBe(true);
    // The exact read the Users screen does. Without the filter this set would contain a revoked user.
    expect(new Set(all.filter((g) => g.revokedAt == null).map((g) => g.appUserId)).has(appUserId)).toBe(false);
  });
});
