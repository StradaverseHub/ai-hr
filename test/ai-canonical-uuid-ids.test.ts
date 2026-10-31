/** zod 4 `z.uuid()` / `z.string().uuid()` are STRICT RFC 9562 (version + variant nibbles). PostgreSQL
 * `uuid` accepts any 8-4-4-4-12 hex value, and the demo/staging fixtures use non-RFC ids such as tenant
 * 11111111-1111-1111-1111-111111111111 (db/seed.ts). Every AI-added id validator must therefore use the
 * repository canonical form (`z.guid()`, as lib/system-testing/model.ts; or the 8-4-4-4-12 regex of
 * lib/identity/manual-model.ts) or the demo tenant refuses with a generic "unavailable". No database. */
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { Tx } from "../db/client";
import { LeaveDependencyUnavailable, lockLeaveDependenciesTx, lockLeaveDependencyConfigurationTx, lockLeaveDependencyReadConfigurationTx } from "../core/leave-dependency-lock";
import { OWN_LEAVE_CONTRACT_VERSION, OwnLeaveConfirmation, OwnLeaveHumanSelection } from "../lib/assistant-actions/own-leave-contract";
import { AttendanceClockSelection } from "../lib/assistant-actions/module-action-http";
import { CountryStatutoryReviewRetirement } from "../lib/assistant-actions/country-statutory-review-contract";
import { REVIEWED_COUNTRY_STATUTORY_ACTION } from "../lib/assistant-actions/reviewed-country-statutory-contract";

const DEMO_TENANT = "11111111-1111-1111-1111-111111111111";
const DEMO_USER = "22222222-2222-2222-2222-222222222222";
const ACCEPTED = [DEMO_TENANT, DEMO_USER, DEMO_TENANT.replace(/1/g, "A").replace(/^A{8}/, "ABCDEF12")];
const REFUSED = ["not-a-uuid", "", "11111111-1111-1111-1111-11111111111", "11111111-1111-1111-1111-11111111111g"];
const digest = "a".repeat(64);

const validators: Record<string, (id: string) => boolean> = {
  OwnLeaveHumanSelection: id => OwnLeaveHumanSelection.safeParse({ employmentId: id, leaveTypeId: id }).success,
  OwnLeaveConfirmation: id => OwnLeaveConfirmation.safeParse({ actionId: id, contractVersion: OWN_LEAVE_CONTRACT_VERSION, reviewedDigest: digest }).success,
  AttendanceClockSelection: id => AttendanceClockSelection.safeParse({ employmentId: id, date: "2026-01-15" }).success,
  CountryStatutoryReviewRetirement: id => CountryStatutoryReviewRetirement.safeParse({ action: REVIEWED_COUNTRY_STATUTORY_ACTION, contractVersion: 1, actionId: id }).success,
};

function fakeTx() {
  const execute = vi.fn(async () => [{ acquired: true }]);
  return { tx: { execute } as unknown as Tx, execute };
}

describe("AI id validators accept PostgreSQL-canonical UUIDs, not only RFC 9562 versioned ones", () => {
  it("fixture premise: the demo ids are non-RFC and the refusal set is exactly what it claims", () => {
    expect(DEMO_TENANT).toHaveLength(36);
    expect(ACCEPTED[2]).toBe("ABCDEF12-AAAA-AAAA-AAAA-AAAAAAAAAAAA");
    expect(REFUSED[2]).toHaveLength(35);
    // Version nibble 1 with variant nibble 1 is outside RFC 9562; the strict zod form refuses it.
    expect(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(DEMO_TENANT)).toBe(false);
  });

  for (const [name, accepts] of Object.entries(validators)) {
    it(`${name} accepts the demo ids and an uppercase id, and still refuses malformed ids`, () => {
      for (const id of ACCEPTED) expect(accepts(id), id).toBe(true);
      for (const id of REFUSED) expect(accepts(id), JSON.stringify(id)).toBe(false);
    });
  }

  it("the leave dependency locks admit the demo tenant and employment (the db:seed setLeaveTypeRules path)", async () => {
    for (const tenant of ACCEPTED) {
      const { tx, execute } = fakeTx();
      await lockLeaveDependencyConfigurationTx(tx, tenant);
      await lockLeaveDependencyReadConfigurationTx(tx, tenant);
      await lockLeaveDependenciesTx(tx, tenant, [DEMO_USER, DEMO_USER.toUpperCase()]);
      expect(execute).toHaveBeenCalledTimes(4);
    }
    for (const bad of REFUSED) {
      const { tx, execute } = fakeTx();
      await expect(lockLeaveDependencyConfigurationTx(tx, bad)).rejects.toThrow(LeaveDependencyUnavailable);
      await expect(lockLeaveDependenciesTx(tx, DEMO_TENANT, [bad])).rejects.toThrow(LeaveDependencyUnavailable);
      expect(execute).not.toHaveBeenCalled();
    }
  });
});

/** The inventory of every source file under core/ packs/ app/ lib/ db/ scripts/ to which the AI work
 * ADDED a strict UUID validator (diff origin/alpha...candidate). Alpha-owned validators are excluded:
 * app/(app)/performance/onehr-actions.ts and packs/performance/onehr/{ai,calibration-conversation,
 * development-suggestion-service,feedback-conversation}.ts keep their z.uuid() calls unchanged from alpha. */
const AI_ID_VALIDATOR_FILES = [
  "app/(app)/assistant/native-outcome-actions.ts",
  "core/ai-provider-readiness.ts",
  "core/assistant-actions/attendance-correction-review-store.ts",
  "core/assistant-actions/country-statutory-review-store.ts",
  "core/assistant-actions/knowledge-article-review-store.ts",
  "core/assistant-actions/leave-decision-review-store.ts",
  "core/assistant-actions/lifecycle-ack-review-store.ts",
  "core/assistant-actions/module-action-review-store.ts",
  "core/assistant-actions/module-action-server.ts",
  "core/assistant-actions/multi-cycle-run-review-store.ts",
  "core/assistant-actions/org-action-review-store.ts",
  "core/assistant-actions/own-attendance-correction-source.ts",
  "core/assistant-actions/own-claim-submission-source.ts",
  "core/assistant-actions/own-leave-reconciliation.ts",
  "core/assistant-actions/own-leave-review.ts",
  "core/assistant-actions/own-leave-store.ts",
  "core/assistant-actions/own-lifecycle-acknowledgement-source.ts",
  "core/assistant-actions/own-toil-replacement-source.ts",
  "core/assistant-actions/pay-component-review-store.ts",
  "core/assistant-actions/payroll-close-review-store.ts",
  "core/assistant-actions/reviewed-country-statutory-source.ts",
  "core/assistant-actions/reviewed-leave-decision-source.ts",
  "core/assistant-actions/reviewed-rewards-post-source.ts",
  "core/assistant-actions/rewards-post-review-store.ts",
  "core/assistant-actions/toil-request-review-store.ts",
  "core/leave-dependency-lock.ts",
  "core/module-native-outcome-references.ts",
  "core/module-native-outcome-targets.ts",
  "core/module-native-outcome-workspace.ts",
  "core/personnel-import-assistance-store.ts",
  "lib/ai/module-native-outcomes.ts",
  "lib/ai/module-native-signals.ts",
  "lib/ai/provider-evaluation-receipt.ts",
  "lib/assistant-actions/attendance-correction-review-contract.ts",
  "lib/assistant-actions/country-statutory-review-contract.ts",
  "lib/assistant-actions/knowledge-article-contract.ts",
  "lib/assistant-actions/knowledge-article-review-contract.ts",
  "lib/assistant-actions/leave-decision-review-contract.ts",
  "lib/assistant-actions/lifecycle-ack-review-contract.ts",
  "lib/assistant-actions/module-action-http.ts",
  "lib/assistant-actions/module-action-review-contract.ts",
  "lib/assistant-actions/multi-cycle-run-browser-contract.ts",
  "lib/assistant-actions/multi-cycle-run-review-contract.ts",
  "lib/assistant-actions/org-action-review-contract.ts",
  "lib/assistant-actions/own-attendance-correction-contract.ts",
  "lib/assistant-actions/own-claim-contract.ts",
  "lib/assistant-actions/own-claim-submission-contract.ts",
  "lib/assistant-actions/own-leave-contract.ts",
  "lib/assistant-actions/own-leave-http.ts",
  "lib/assistant-actions/own-lifecycle-acknowledgement-contract.ts",
  "lib/assistant-actions/own-notification-preferences-contract.ts",
  "lib/assistant-actions/own-onehr-plan-acknowledgement-contract.ts",
  "lib/assistant-actions/own-profile-change-contract.ts",
  "lib/assistant-actions/own-review-acknowledgement-contract.ts",
  "lib/assistant-actions/own-toil-replacement-contract.ts",
  "lib/assistant-actions/pay-component-review-contract.ts",
  "lib/assistant-actions/payroll-close-review-contract.ts",
  "lib/assistant-actions/reviewed-country-statutory-contract.ts",
  "lib/assistant-actions/reviewed-leave-decision-contract.ts",
  "lib/assistant-actions/reviewed-multi-cycle-run-contract.ts",
  "lib/assistant-actions/reviewed-pay-component-contract.ts",
  "lib/assistant-actions/reviewed-payroll-close-contract.ts",
  "lib/assistant-actions/reviewed-reporting-line-contract.ts",
  "lib/assistant-actions/reviewed-rewards-post-contract.ts",
  "lib/assistant-actions/rewards-post-review-contract.ts",
  "lib/assistant-actions/toil-request-review-contract.ts",
  "lib/personnel-import-assistance.ts",
  "lib/personnel-import-evaluation.ts",
  "scripts/fixtures/ai-delivery-provider-config-native-readback.ts",
] as const;

describe("source guard: no strict RFC-only UUID validator returns to the AI-added files", () => {
  it("scans a real, complete file list", () => {
    expect(AI_ID_VALIDATOR_FILES.length).toBe(69);
    expect(new Set(AI_ID_VALIDATOR_FILES).size).toBe(AI_ID_VALIDATOR_FILES.length);
  });
  for (const file of AI_ID_VALIDATOR_FILES) {
    it(file, () => {
      const path = join(process.cwd(), file);
      expect(statSync(path).isFile()).toBe(true);
      const src = readFileSync(path, "utf8");
      // An empty or truncated read must not pass as "no violations".
      expect(src.length).toBeGreaterThan(200);
      // Non-vacuity: each file still validates ids, in the canonical form.
      expect(/z\.guid\(\)|\{8\}-\[(?:a-f0-9|0-9a-f)\]\{4\}-\[(?:a-f0-9|0-9a-f)\]\{4\}-\[(?:a-f0-9|0-9a-f)\]\{4\}-/.test(src)).toBe(true);
      expect(src).not.toMatch(/\.\s*uuid(?:v\d)?\s*\(/);
      expect(src).not.toMatch(/\bz\s*\.\s*uuid/);
      // Hand-written regexes must not pin RFC version/variant nibbles either.
      expect(src).not.toMatch(/\[1-[1-8]\]\[(?:a-f0-9|0-9a-f)\]\{3\}-\[89ab\]/i);
    });
  }
});
