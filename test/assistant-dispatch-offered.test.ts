/**
 * ADR-0077 × ADR-0082 — DISPATCH RESOLVES ONLY FROM WHAT WAS OFFERED.
 *
 * The defect this pins: askAssistant offered the model `toolsFor(ctx)` (module-filtered) but runTools
 * resolved each call against the WHOLE registry. So a tenant without payroll was never offered
 * `my_payslip_summary`, yet if the model named it anyway — hallucinated, or injected through a tool
 * result — it ran, and the caller's released payslip went into the model's context. RLS still held (it
 * is the caller's own payslip); the module gate did not.
 *
 * The loop is driven for real against a real database as `ai_hr_app`; only `converse` is replaced, so
 * the model's tool choice is scripted and every turn the loop would send to a provider is captured.
 *
 * NON-VACUITY IS IN THE FILE: the second case runs the identical script on a tenant that DOES hold
 * payroll and watches the sentinel arrive. If the first case's sentinel assertion were checking a value
 * the tool could never return, the second would fail.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { and, eq } from 'drizzle-orm';
import type { SessionContext } from '../db/client';
import * as schema from '../db/schema';
import type { ConverseResult } from '../lib/ai/types';
import { askAssistant } from '../core/assistant';
import { loadAiWorkspace } from '../core/ai-workspace';
import { ASSISTANT_PUBLIC_REPLIES } from '../lib/ai/assistant-public-replies';
import { grantAssistant } from '../core/assistant-grant';
import { ASSISTANT_TOOLS, toolsFor } from '../core/assistant-tools';
import { hireEmployee } from '../core/org';
import { setCompensation } from '../core/comp';
import { setStatutoryProfileMY } from '../localization/my/statutory';
import { closeBatch, createBatch, generatePayslips } from '../core/payroll';
import { adminCtx, closeAll, createAppUser, entitledCtx, migrateTestDb, owner, resetDb, seedBase, setModule, type Base } from './harness';

const { converse } = vi.hoisted(() => ({ converse: vi.fn() }));
vi.mock('../lib/ai', async (importOriginal) => ({ ...(await importOriginal<typeof import('../lib/ai')>()), converse }));

const usage = { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 };
const toolUse = (calls: { id: string; name: string; input: unknown }[]): ConverseResult => ({
  text: '',
  toolCalls: calls,
  stop: 'tool_use',
  usage,
});
const end: ConverseResult = { text: 'Done.', toolCalls: [], stop: 'end', usage };

/** A basic salary nothing else in the fixture produces, so its appearance can only be the payslip. */
const SENTINEL_BASIC = 7319;

let base: Base;

beforeAll(migrateTestDb);
beforeEach(async () => {
  await resetDb();
  base = await seedBase();
  converse.mockReset();
  // resolveActiveAiConfig falls back to an env key when no tenant config is stored. `converse` is mocked,
  // so the key is never sent anywhere; the stub only makes a config exist.
  vi.stubEnv('AI_CONFIG_SECRET', 'fictional-dispatch-disclosure-only');
  vi.stubEnv('OPENAI_API_KEY', 'fixture-never-sent');
  vi.stubEnv('ANTHROPIC_API_KEY', '');
  vi.stubEnv('GOOGLE_API_KEY', '');
  vi.stubEnv('GEMINI_API_KEY', '');
});
afterAll(async () => {
  vi.unstubAllEnvs();
  await closeAll();
});

/**
 * An employee with a RELEASED payslip, an assistant grant, and a session whose entitlement snapshot is
 * resolved from the tenant's real rows AFTER `payroll` is set as asked.
 */
async function employeeWithReleasedPayslip(payroll: boolean): Promise<{ ctx: SessionContext; net: string }> {
  const a = adminCtx(base); // synthetic snapshot with payroll on: the payslip is created while it is held
  const E = await hireEmployee(a, {
    person: { fullName: 'Dispatch Dana', primaryEmail: 'dispatch.dana@acme.test' },
    companyId: base.companyId,
    departmentId: base.deptA,
    employmentType: 'full_time',
    hiredOn: '2026-01-01',
  });
  await setCompensation(a, { employmentId: E.employmentId, basicSalary: SENTINEL_BASIC, monthlyAllowance: 0, effectiveFrom: '2026-01-01' });
  await setStatutoryProfileMY(a, { personId: E.personId, icNumber: '910707030001' });
  const { batchId } = await createBatch(a, { companyId: base.companyId, payPeriod: '2026-03' });
  await generatePayslips(a, { batchId });
  await closeBatch(a, { batchId }); // released: what my_payslip_summary returns

  const [slip] = await owner.db
    .select({ net: schema.payslip.netPay })
    .from(schema.payslip)
    .where(and(eq(schema.payslip.batchId, batchId), eq(schema.payslip.employmentId, E.employmentId)));
  expect(slip, 'the released payslip must exist, or the sentinel assertion asserts nothing').toBeTruthy();

  const userId = await createAppUser(base.tenantId, E.personId, 'employee');
  await setModule(base.tenantId, 'assistant', 'active');
  if (!payroll) await setModule(base.tenantId, 'payroll', null);
  await grantAssistant(a, { appUserId: userId });

  const snap = await entitledCtx(base, ['employee']);
  const ctx: SessionContext = { ...snap, userId, personId: E.personId, roles: ['employee'], grants: [{ role: 'employee', companyId: null }] };
  return { ctx, net: String(Number(slip.net)) };
}

/** Everything the loop sent to the provider, across every turn. */
const sentToModel = () => JSON.stringify(converse.mock.calls.map(([, args]) => args));

const auditOf = async (exchangeId: string) => {
  const [row] = await owner.db
    .select({ toolCalls: schema.assistantExchange.toolCalls })
    .from(schema.assistantExchange)
    .where(eq(schema.assistantExchange.id, exchangeId));
  return row.toolCalls as { name: string; refusal?: string; rowCount: number | null }[];
};

const toolTurn = () => {
  const turns = converse.mock.calls[1][1].turns as { role: string; results?: { id: string; content: string; isError?: boolean }[] }[];
  const tool = turns.find((t) => t.role === 'tool');
  expect(tool, 'the second converse call must carry the tool results').toBeTruthy();
  return tool!.results!;
};

describe('a tool call the exchange did not offer is never dispatched', () => {
  it('tenant WITHOUT payroll: my_payslip_summary is refused not_offered and the payslip never reaches the model', async () => {
    const { ctx, net } = await employeeWithReleasedPayslip(false);

    // The data is REAL and reachable: the tool itself, run directly for this caller, returns the
    // sentinel. So its absence below is the dispatch refusing, not an empty read.
    const direct = await ASSISTANT_TOOLS.find((t) => t.spec.name === 'my_payslip_summary')!.run(ctx, { limit: 12 });
    expect(JSON.stringify(direct)).toContain(net);
    expect(toolsFor(ctx).map((t) => t.spec.name)).not.toContain('my_payslip_summary');

    converse
      .mockResolvedValueOnce(
        toolUse([
          { id: 'c1', name: 'my_payslip_summary', input: { limit: 12 } },
          { id: 'c2', name: 'no_such_tool_anywhere', input: {} },
        ]),
      )
      .mockResolvedValueOnce(end);

    const res = await askAssistant(ctx, { question: 'What was my last net pay?' });
    expect(res.stop).toBe('end');
    expect(converse).toHaveBeenCalledTimes(2);

    // The model was never offered it.
    for (const [, args] of converse.mock.calls) {
      expect((args.tools as { name: string }[]).map((s) => s.name)).not.toContain('my_payslip_summary');
    }

    // The audit separates the two; the model cannot.
    const audit = await auditOf(res.exchangeId);
    expect(audit.find((a) => a.name === 'my_payslip_summary')?.refusal).toBe('not_offered');
    expect(audit.find((a) => a.name === 'no_such_tool_anywhere')?.refusal).toBe('unknown_tool');

    const [notOffered, unknown] = toolTurn();
    expect(notOffered).toMatchObject({ id: 'c1', content: ASSISTANT_PUBLIC_REPLIES.tool, isError: true });
    // NO ORACLE: a registered-but-not-offered name reads exactly like a name that does not exist.
    expect({ content: notOffered.content, isError: notOffered.isError }).toEqual({ content: unknown.content, isError: unknown.isError });

    expect(sentToModel()).not.toContain(net);
  });

  it('tenant WITH payroll: the same script runs the tool and the sentinel arrives (non-vacuity)', async () => {
    const { ctx, net } = await employeeWithReleasedPayslip(true);
    expect(toolsFor(ctx).map((t) => t.spec.name)).toContain('my_payslip_summary');

    converse.mockResolvedValueOnce(toolUse([{ id: 'c1', name: 'my_payslip_summary', input: { limit: 12 } }]))
      .mockResolvedValueOnce({ ...end, text: `Fictional released net pay: ${net}.` });

    const res = await askAssistant(ctx, { question: 'What was my last net pay?' });
    const audit = await auditOf(res.exchangeId);
    expect(audit[0]).toMatchObject({ name: 'my_payslip_summary', rowCount: 1 });
    expect(audit[0].refusal).toBeUndefined();
    expect(toolTurn()[0].isError).toBeUndefined();
    expect(sentToModel()).toContain(net);
    const [stored] = await owner.db.select().from(schema.assistantExchange).where(eq(schema.assistantExchange.id, res.exchangeId));
    expect(stored.disclosureReceipt).toBeTruthy();
    const reopened = await loadAiWorkspace(ctx);
    expect(reopened.history[0]).toMatchObject({ id: res.exchangeId, answer: res.answer, answerVisibility: 'current' });
    expect(JSON.stringify(reopened)).not.toContain(stored.disclosureReceipt!);
    // Actual command -> source receipt -> canonical replay -> module revocation, no forged backfill.
    await setModule(base.tenantId, 'payroll', null);
    const retired = await loadAiWorkspace(ctx);
    expect(retired.history[0]).toMatchObject({ id: res.exchangeId, answer: null, answerVisibility: 'unavailable' });
    expect(JSON.stringify(retired)).not.toContain(net);
  });
});


describe('actual Assistant consumption of bounded agent batches', () => {
  it('refuses duplicate IDs and excessive fan-out before any otherwise offered reader runs', async () => {
    const { ctx } = await employeeWithReleasedPayslip(true);
    const tool = ASSISTANT_TOOLS.find(t => t.spec.name === 'my_payslip_summary')!;
    const spy = vi.spyOn(tool, 'run');
    try {
      const duplicate = [
        { id: 'same', name: tool.spec.name, input: { limit: 1 } },
        { id: 'same', name: tool.spec.name, input: { limit: 1 } },
      ];
      const excessive = Array.from({ length: 17 }, (_, i) => ({ id: `c${i}`, name: tool.spec.name, input: { limit: 1 } }));
      for (const batch of [duplicate, excessive]) {
        converse.mockReset(); converse.mockResolvedValueOnce(toolUse(batch));
        await expect(askAssistant(ctx, { question: 'Read my released payslip.' })).rejects.toMatchObject({ code: 'provider_error' });
        expect(converse).toHaveBeenCalledTimes(1);
        expect(spy).not.toHaveBeenCalled();
      }
      // The same offered tool really can run after a valid proposal; no global disabling shortcut.
      converse.mockReset();
      converse.mockResolvedValueOnce(toolUse([{ id: 'valid', name: tool.spec.name, input: { limit: 1 } }])).mockResolvedValueOnce(end);
      await expect(askAssistant(ctx, { question: 'Read my released payslip.' })).resolves.toMatchObject({ stop: 'end' });
      expect(spy).toHaveBeenCalledTimes(1);
    } finally { spy.mockRestore(); }
  });

  it('keeps refusal codes in the server audit and gives the model only the public access reply', async () => {
    const { ctx } = await employeeWithReleasedPayslip(true);
    converse.mockResolvedValueOnce(toolUse([{ id: 'private', name: 'employee_profile',
      input: { employment_id: 'ffffffff-ffff-4fff-bfff-ffffffffffff' } }])).mockResolvedValueOnce(end);
    const result = await askAssistant(ctx, { question: 'Can you open this profile?' });
    expect(JSON.parse(toolTurn()[0].content)).toEqual({ ok: false, message: ASSISTANT_PUBLIC_REPLIES.access });
    expect(JSON.stringify(toolTurn())).not.toContain('not_visible');
    expect((await auditOf(result.exchangeId))[0].refusal).toBe('not_visible');
  });

  it('turns a raw source exception into the friendly safe reply without exposing its cause', async () => {
    const { ctx } = await employeeWithReleasedPayslip(true);
    const tool = ASSISTANT_TOOLS.find(t => t.spec.name === 'my_payslip_summary')!;
    const raw = 'PRIVATE_DATABASE_ERROR_SENTINEL: SELECT salary FROM secret_table; provider-key-fragment';
    const spy = vi.spyOn(tool, 'run').mockRejectedValueOnce(new Error(raw));
    try {
      converse.mockResolvedValueOnce(toolUse([{ id: 'failed', name: tool.spec.name, input: { limit: 1 } }])).mockResolvedValueOnce(end);
      const result = await askAssistant(ctx, { question: 'Read my released payslip.' });
      expect(toolTurn()).toEqual([{ id: 'failed', name: tool.spec.name, content: ASSISTANT_PUBLIC_REPLIES.lookup, isError: true }]);
      expect(sentToModel()).not.toContain(raw); expect(JSON.stringify(result)).not.toContain(raw);
      expect(JSON.stringify(await auditOf(result.exchangeId))).not.toContain(raw);
    } finally { spy.mockRestore(); }
  });

  it('does not send oversized read content into the next provider turn or persist it as rows', async () => {
    const { ctx } = await employeeWithReleasedPayslip(true);
    const tool = ASSISTANT_TOOLS.find(t => t.spec.name === 'my_payslip_summary')!;
    const sentinel = 'OVERSIZED_CANONICAL_READ_SENTINEL';
    const spy = vi.spyOn(tool, 'run').mockResolvedValueOnce({ ok: true, text: sentinel + '界'.repeat(23_000) });
    try {
      converse.mockResolvedValueOnce(toolUse([{ id: 'large', name: tool.spec.name, input: { limit: 1 } }])).mockResolvedValueOnce(end);
      const result = await askAssistant(ctx, { question: 'Read my released payslip.' });
      expect(spy).toHaveBeenCalledTimes(1);
      expect(toolTurn()).toEqual([{ id: 'large', name: tool.spec.name, content: ASSISTANT_PUBLIC_REPLIES.lookup, isError: true }]);
      expect(sentToModel()).not.toContain(sentinel);
      const audit = await auditOf(result.exchangeId);
      expect(audit).toEqual([{ name: tool.spec.name, input: { limit: 1 }, rowCount: null, refusal: 'tool_error' }]);
      expect(JSON.stringify(audit)).not.toContain(sentinel);
    } finally { spy.mockRestore(); }
  });
});
