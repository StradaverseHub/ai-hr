/**
 * ADR-0084 §2.7 — input triage's PURE half. No database, no provider.
 *
 * §2.7 gives this layer one licence and one leash. The licence: it may read an employee's own words and
 * ask them a question. The leash: **it can never reject anything**, the `policyRuleId` must exist in the
 * closed catalogue, and any figure the question names must match the source record. Every one of those is
 * `adjudicateTriage`, and a refusal nobody tests is a refusal nobody knows still works.
 *
 * The last case is the important one and it is a source-shape assertion rather than a behavioural one:
 * a leash you can only demonstrate by exercising every path is a leash with a hole you have not found.
 */
import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import {
  TRIAGE_RULES,
  THIN_DESCRIPTION_CHARS,
  VERDICT_OK,
  adjudicateTriage,
  type ClaimFacts,
} from '../core/input-triage';
import en from '../messages/en.json';

const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');

const claim = (over: Partial<ClaimFacts> = {}): ClaimFacts => ({
  claimId: 'c1',
  type: 'Mileage',
  item: 'Client visit',
  amount: 312.5,
  incurredOn: '2026-08-14',
  submittedOn: '2026-08-15',
  description: 'Drove to the client site in Shah Alam and back',
  ...over,
});

const ok = (p: Parameters<typeof adjudicateTriage>[0], f = claim()) => adjudicateTriage(p, f);
const why = (a: ReturnType<typeof adjudicateTriage>) => (a.ok ? null : a.reason);

describe('the clean verdict is the expected answer, and it carries nothing', () => {
  it('accepts a bare ok', () => {
    expect(ok({ verdict: VERDICT_OK })).toEqual({ ok: true });
  });

  it('refuses an ok that also raises a rule — that is not a clean verdict', () => {
    expect(why(ok({ verdict: VERDICT_OK, policyRuleId: 'claim.category_mismatch' }))).toBe('rule_on_ok_verdict');
  });
});

describe('a query is adjudicated against the claim, never taken on trust', () => {
  it('accepts a query whose rule is catalogued, whose question is plain, and whose figures are the claim’s', () => {
    expect(
      ok({
        verdict: 'query',
        policyRuleId: 'claim.category_mismatch',
        reason: 'This is filed under Mileage but reads like a meal — is that right?',
      }),
    ).toEqual({ ok: true });
  });

  it('refuses a verdict outside the two the contract allows — and there is no third', () => {
    expect(why(ok({ verdict: 'reject', policyRuleId: 'claim.category_mismatch', reason: 'No.' }))).toBe(
      'unknown_verdict',
    );
    expect(why(ok({ verdict: 'approve' }))).toBe('unknown_verdict');
  });

  it('refuses a rule that is not in the catalogue', () => {
    expect(why(ok({ verdict: 'query', policyRuleId: 'claim.looks_dodgy', reason: 'Hmm?' }))).toBe(
      'unknown_rule:claim.looks_dodgy',
    );
    expect(why(ok({ verdict: 'query', reason: 'Hmm?' }))).toBe('unknown_rule:');
  });

  it('refuses a query with no question, one too long to read, or one carrying markup or a link', () => {
    const r = (reason: string) => why(ok({ verdict: 'query', policyRuleId: 'claim.category_mismatch', reason }));
    expect(r('  ')).toBe('no_reason');
    expect(r('x'.repeat(201))).toBe('reason_too_long');
    expect(r('See https://example.test/policy')).toBe('reason_not_plain_text');
    expect(r('Please check {{claimType}}')).toBe('reason_not_plain_text');
  });

  /**
   * §2.7: "any referenced figure must match the source record". The figure check is `narrationIsFaithful`,
   * borrowed unchanged from the narrator — so a question that invents a number is discarded exactly as
   * prose that invents one is.
   */
  it('refuses a question that names a figure the claim does not carry', () => {
    expect(
      why(
        ok({
          verdict: 'query',
          policyRuleId: 'claim.amount_unexplained',
          reason: 'The claim is for 980 — what does that cover?',
        }),
      ),
    ).toBe('unsupported_figure');
  });

  it('accepts a question quoting the claim’s OWN figures, including one the employee wrote themselves', () => {
    expect(
      ok({
        verdict: 'query',
        policyRuleId: 'claim.amount_unexplained',
        reason: 'The claim is for 312.5 — what does that cover?',
      }),
    ).toEqual({ ok: true });
    // The description is part of the source record: a figure the employee put there is theirs to be
    // quoted back at them.
    expect(
      ok(
        { verdict: 'query', policyRuleId: 'claim.amount_unexplained', reason: 'You mention 60 for the taxi — is the rest parking?' },
        claim({ description: 'Taxi 60 and parking' }),
      ),
    ).toEqual({ ok: true });
  });
});

describe('each rule carries a precondition that is re-derived, not assumed', () => {
  it('a claim whose description names no date cannot be date-inconsistent, however sure the model sounds', () => {
    expect(
      why(
        ok(
          { verdict: 'query', policyRuleId: 'claim.date_inconsistent', reason: 'Is this the right month?' },
          claim({ description: 'Drove to the client site and back' }),
        ),
      ),
    ).toBe('rule_unsupported:claim.date_inconsistent');
    // …and the same rule IS available once the description actually names one.
    expect(
      ok(
        { verdict: 'query', policyRuleId: 'claim.date_inconsistent', reason: 'You mention December — the receipt is dated in August.' },
        claim({ description: 'December client visit' }),
      ),
    ).toEqual({ ok: true });
  });

  it('a description long enough to work with cannot be too thin', () => {
    expect(
      why(ok({ verdict: 'query', policyRuleId: 'claim.detail_insufficient', reason: 'Could you say what this was for?' })),
    ).toBe('rule_unsupported:claim.detail_insufficient');
    expect(
      ok(
        { verdict: 'query', policyRuleId: 'claim.detail_insufficient', reason: 'Could you say what this was for?' },
        claim({ description: 'expenses' }),
      ),
    ).toEqual({ ok: true });
    expect('expenses'.length).toBeLessThan(THIN_DESCRIPTION_CHARS);
  });

  it('an empty description supports ONLY the thinness rule — the others have nothing to read', () => {
    const blank = claim({ description: '' });
    for (const rule of TRIAGE_RULES) {
      const a = adjudicateTriage({ verdict: 'query', policyRuleId: rule, reason: 'Could you add a note?' }, blank);
      if (rule === 'claim.detail_insufficient') expect(a, rule).toEqual({ ok: true });
      else expect(why(a), rule).toBe(`rule_unsupported:${rule}`);
    }
  });
});

describe('the leash §2.7 puts on this layer is structural', () => {
  it('there is no reject anywhere in the module — not a branch, not a status write', () => {
    const src = read('core/input-triage.ts');
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    // The vocabulary has two verdicts and neither of them refuses anything.
    expect(code).not.toMatch(/'reject(ed)?'/);
    // And nothing here can move a claim: no write to claim_request, no status set, in any form.
    expect(code, 'triage must never write to a claim').not.toMatch(/update\(schema\.claimRequest\)/);
    expect(code, 'and must never set a status').not.toMatch(/status:\s*'/);
  });

  it('the prompt offers exactly the catalogue, in both directions', () => {
    const src = read('core/input-triage.ts');
    const system = src.slice(src.indexOf('const SYSTEM = ['), src.indexOf("].join(' ');", src.indexOf('const SYSTEM = [')));
    for (const rule of TRIAGE_RULES) expect(system, `the prompt never offers '${rule}'`).toContain(rule);
    for (const offered of [...system.matchAll(/\b(claim\.[a-z_]+)\b/g)].map((m) => m[1]!)) {
      expect(TRIAGE_RULES as readonly string[], `prompt offers '${offered}', which is not catalogued`).toContain(
        offered,
      );
    }
    // …and it must tell the model that the quiet answer is the usual one, or every claim gets a question.
    expect(system).toContain('MOST OF THE TIME');
  });

  it('the question reaches the CLAIMANT, and the notification says nothing is wrong', () => {
    const notif = read('core/notifications.ts');
    const entry = notif.slice(notif.indexOf("'claim-request.triage-queried'"), notif.indexOf("'claim-request.approved'"));
    expect(entry, 'no recipients override — the default resolver is the subject, who is the claimant').not.toContain(
      'recipients:',
    );
    expect(entry, 'info, never warning: nothing is wrong and nothing is refused').toContain("severity: 'info'");
  });

  it('the tenant switch is catalogued and the call site passes the literal the drift guard can see', () => {
    expect(read('core/input-triage.ts')).toContain("settingEnabled(ctx, 'claims.input_triage_enabled')");
    const catalog = read('packs/catalog.ts');
    expect(catalog).toContain("key: 'claims.input_triage_enabled'");
    expect(catalog).toContain("'claims.input_triage_enabled': null");
  });

  it('the roster row that describes it to an admin has its six-locale strings', () => {
    expect((en.controlTower.agent as Record<string, string>).triage).toBeTruthy();
    expect((en.controlTower.agent as Record<string, string>).triageDoes).toBeTruthy();
    for (const k of ['triageOn', 'triageOff']) {
      expect((en.controlTower.why as Record<string, string>)[k], k).toBeTruthy();
    }
  });
});
