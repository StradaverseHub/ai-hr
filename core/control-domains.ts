/**
 * ADR-0083 step 1 — THE DOMAIN-ADAPTER SEAM, and the live agent roster behind it.
 *
 * ADR-0076 built a control loop and welded it to `payroll_batch`. Strip the payroll nouns out of it and
 * nothing that remains is about payslips:
 *
 *     deterministic detectors → typed findings with provenance → optional narration that CANNOT change a
 *     verdict → a queue with human disposition → metrics that gate how much autonomy is granted next
 *
 * That is a control plane for operational HR. This file is the seam that says so: the Control Tower and
 * the explainer both read THIS REGISTRY rather than calling payroll functions by name, so landing a second
 * adapter (record readiness, onboarding, compliance — ADR-0083 §3) is a registration rather than a rewrite
 * of every surface.
 *
 * WHY THIS IS A REGISTRY AND NOT AN INTERFACE WITH ONE IMPLEMENTATION. There is exactly one adapter today
 * and a single-member abstraction is usually a smell. It earns its place here for one reason: the SCREENS
 * are the thing being generalised, not the evaluator. A tower that hardcodes "payroll" in its headings,
 * its counts and its links has to be rewritten for the second domain; one that iterates a list does not.
 * The evaluator stays exactly where it is.
 *
 * ⚠️ NOTHING HERE COMPUTES OR CLASSIFIES ANYTHING. It describes what exists and reports whether each agent
 * is switched on. ADR-0074's invariant — the LLM never computes the money — is untouched by this file and
 * by everything it points at.
 */
import { and, desc, eq, isNull } from 'drizzle-orm';
import { withTenant, type SessionContext } from '../db/client';
import * as schema from '../db/schema';
import { resolveActiveAiConfig } from './ai-config';
import { isModuleEnabled } from './entitlements';
import { mayUseAssistant } from './assistant-grant';
import { DETECTORS } from './payroll-anomaly-detectors';

/** How work arrives in a domain's queue. Drives one sentence on the explainer, nothing else. */
export type ControlTrigger = 'after_a_payroll_run' | 'nightly' | 'on_change';

export type ControlDomain = {
  id: string;
  /** Key under `controlTower.domain` — the domain's name and its one-line description. */
  labelKey: string;
  /** The module a tenant must hold for this domain to have anything to say. */
  module: string | null;
  trigger: ControlTrigger;
  /** How many deterministic checks it runs. Read from the detector list, never hand-counted. */
  detectorCount: number;
  /** `planned` domains are LISTED on the explainer and produce nothing — see the comment on the list. */
  status: 'live' | 'planned';
};

/**
 * THE PLANNED ROWS ARE DELIBERATE AND ARE NOT VAPOURWARE ON A SCREEN.
 *
 * They are shown to an ADMIN on an explainer page whose whole purpose is "what does this thing do and
 * what is switched on", and a roadmap the operator can see is how they know the queue they are working is
 * one of several rather than the whole story. They are marked `planned` in the type, rendered as such,
 * and produce no counts anywhere. Removing them would make the page read as though payroll were the only
 * loop that will ever exist, which is the exact misconception ADR-0083 was written to correct.
 */
export const CONTROL_DOMAINS: readonly ControlDomain[] = [
  {
    id: 'payroll',
    labelKey: 'payroll',
    module: 'payroll',
    trigger: 'after_a_payroll_run',
    detectorCount: DETECTORS.length,
    status: 'live',
  },
  // ADR-0083 §3 item 2 — the loop that feeds every other loop, built in r234.
  //
  // `module: null` because record completeness is not a payroll question: the same missing IC blocks a
  // statutory return and the same missing bank account blocks a payment, so a tenant without the payroll
  // module still has records that are either ready or not.
  //
  // `detectorCount: 6` is the six gaps in core/record-readiness.ts's ReadinessGapId. It is a literal here
  // and the payroll row's is derived, which is a real inconsistency: the readiness checks are a union
  // type rather than a runtime list, so there is nothing to take a length of. test/record-readiness.test.ts
  // pins the two together so the literal cannot drift.
  { id: 'readiness', labelKey: 'readiness', module: null, trigger: 'on_change', detectorCount: 6, status: 'live' },
  // §3 item 5.
  { id: 'onboarding', labelKey: 'onboarding', module: null, trigger: 'on_change', detectorCount: 0, status: 'planned' },
  // §3 item 6.
  { id: 'compliance', labelKey: 'compliance', module: null, trigger: 'nightly', detectorCount: 0, status: 'planned' },
];

/** Domains this tenant actually holds the module for. */
export const domainsFor = (ctx: SessionContext): ControlDomain[] =>
  CONTROL_DOMAINS.filter((d) => d.module === null || isModuleEnabled(ctx, d.module));

/* ═══════════════════════════════════════════════════════════════════════════════════════════════════
 * The agent roster
 * ══════════════════════════════════════════════════════════════════════════════════════════════════ */

/**
 * `deterministic` agents are code — rules and arithmetic, no model, no variance. `llm` agents involve a
 * language model and are therefore the ones a reader is entitled to be suspicious of, so the distinction
 * is rendered rather than buried: an operator should be able to see at a glance which parts of this
 * system can be creative and which cannot.
 */
export type AgentKind = 'deterministic' | 'llm';

export type AgentStatus = {
  id: string;
  kind: AgentKind;
  active: boolean;
  /** Key under `controlTower.why` — why it is off, or how it is on. Never a bare boolean on screen. */
  reasonKey: string;
  /** True when being off is the DESIGNED state rather than a gap to close. */
  offByDesign?: boolean;
};

/** How stale a sweep may be before it stops counting as running. Two days covers a missed night. */
const SWEEP_FRESH_DAYS = 2;

/**
 * What is actually switched on, right now, for this tenant.
 *
 * Every answer is read from the system rather than declared: a page that says "the narrator is active"
 * because a constant says so is worse than no page. The reason is carried beside the flag because "off"
 * with no explanation is the thing an operator cannot act on.
 */
export async function agentStatuses(ctx: SessionContext): Promise<AgentStatus[]> {
  const payrollOn = isModuleEnabled(ctx, 'payroll');

  const [lastSweep, aiConfigured, assistant] = await Promise.all([
    withTenant(ctx, async (tx) => {
      const [row] = await tx
        .select({ at: schema.payrollAnomalyVerdict.computedAt })
        .from(schema.payrollAnomalyVerdict)
        .where(isNull(schema.payrollAnomalyVerdict.supersededAt))
        .orderBy(desc(schema.payrollAnomalyVerdict.computedAt))
        .limit(1);
      return row?.at ?? null;
    }),
    // The narrator and the assistant both need a provider; neither can run on the platform's goodwill.
    withTenant(ctx, (tx) => resolveActiveAiConfig(tx, ctx)).then((c) => c != null),
    mayUseAssistant(ctx).then((a) => a.allowed),
  ]);

  const sweepFresh =
    lastSweep != null && Date.now() - lastSweep.getTime() < SWEEP_FRESH_DAYS * 24 * 60 * 60 * 1000;

  const narrated = await withTenant(ctx, async (tx) => {
    const [row] = await tx
      .select({ id: schema.payrollAnomalyFinding.id })
      .from(schema.payrollAnomalyFinding)
      .where(and(eq(schema.payrollAnomalyFinding.tenantId, ctx.tenantId), isNull(schema.payrollAnomalyFinding.narrative)))
      .limit(1);
    // Nothing un-narrated is not the same as narration being on; the provider check above is the gate.
    return row == null;
  });

  return [
    {
      id: 'detectors',
      kind: 'deterministic',
      active: payrollOn,
      reasonKey: payrollOn ? 'detectorsOn' : 'moduleOff',
    },
    {
      id: 'sweep',
      kind: 'deterministic',
      active: sweepFresh,
      // "Never run" and "ran a fortnight ago" are different faults and get different sentences.
      reasonKey: lastSweep == null ? 'sweepNever' : sweepFresh ? 'sweepOn' : 'sweepStale',
    },
    {
      id: 'narrator',
      kind: 'llm',
      active: aiConfigured,
      reasonKey: aiConfigured ? (narrated ? 'narratorOn' : 'narratorReady') : 'noProvider',
    },
    {
      id: 'assistant',
      kind: 'llm',
      active: assistant,
      reasonKey: assistant ? 'assistantOn' : 'assistantNoGrant',
    },
    {
      // ADR-0083 §2.5 replaced 0074's global dial with per-action-type autonomy, and NONE is granted.
      // Rendered as a row rather than omitted: an operator reading this page is entitled to know that
      // nothing acts on its own, and to see that it is a decision rather than an oversight.
      id: 'autonomy',
      kind: 'deterministic',
      active: false,
      reasonKey: 'autonomyByDesign',
      offByDesign: true,
    },
  ];
}
