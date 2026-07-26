/**
 * Performance module pack (ADR-0080 D8/D11, retrofit ladder rung 4).
 *
 * Verifies the three mechanical halves of the retrofit with behaviour unchanged:
 *   1. Registry: `packs/performance` registers a module pack the registry resolves by id.
 *   2. Nav parity: the pack's navLink is ROW-FOR-ROW the sidebar's pre-rung-4 performance row —
 *      same labelKey, href, icon ref (Target), the same managerUp gate, same group placement
 *      (Manage) — and components/sidebar.tsx mounts it via the registry instead of hardcoding it
 *      (the EXPECTED table below is the pre-change literal, captured verbatim; any drift is a
 *      rendering change by definition).
 *   3. Facade: `packs/performance/service` re-exports the implementation — outside callers get
 *      the exact same function references, so switching import paths cannot change behaviour.
 *
 * No kernel contract lands this rung by design (one seam per rung; rung 3 landed
 * PayrollInputContributor): the comp-enactment pay seam is DOCUMENTED debt in
 * packs/performance/index.ts with the Payroll rung (7) as its future home.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { Target } from 'lucide-react';
import { performancePack } from '../packs/performance';
import { listPacks, modulePackById, packById } from '../packs/registry';
import * as facade from '../packs/performance/service';
import * as corePerformance from '../core/performance';

describe('ADR-0080 rung 4: performance pack registration', () => {
  it('registers as a module pack the registry resolves by id', () => {
    expect(packById('performance')).toBe(performancePack);
    expect(modulePackById('performance')).toBe(performancePack);
    expect(performancePack.kind).toBe('module');
    expect(listPacks('module').map((p) => p.id)).toContain('performance');
  });

  it('declares the audited satellite tables (D11 criterion 2)', () => {
    const tables = (performancePack.satelliteTables ?? []).map((t) => t.table);
    expect(tables).toEqual([
      'review_cycle',
      'performance_review',
      'performance_goal',
      'review_goal',
      'performance_checkin',
      'peer_feedback_request',
      'peer_feedback',
      'calibration_session',
      'calibration_entry',
      'performance_attachment',
    ]);
  });

  it('does NOT claim the employment-spine review tables (the 0110 workflow stays kernel)', () => {
    const tables = (performancePack.satelliteTables ?? []).map((t) => t.table);
    for (const spine of ['employment_review', 'employment_review_reminder', 'review_document']) {
      expect(tables, `${spine} is employment-spine, not a performance satellite`).not.toContain(spine);
    }
  });

  it('declares its service facade path (D11 criterion 3 pointer)', () => {
    expect(performancePack.serviceFacade).toBe('packs/performance/service');
  });
});

describe('ADR-0080 rung 4: nav parity with the pre-retrofit sidebar', () => {
  // components/sidebar.tsx performance row as of the commit before rung 4, captured VERBATIM. A
  // single FLAT row in the Manage group (1b35f17b: per-row managerUp gate after the group's
  // whole-group flag was dropped):
  //   manage group: { href: '/performance', labelKey: 'performance', icon: Target, managerUp: true }
  const EXPECTED = [
    { group: 'manage', href: '/performance', labelKey: 'performance', icon: Target, managerUp: true },
  ] as const;

  const links = performancePack.navLinks!;

  it('carries exactly the pre-retrofit row, with identical icon ref and gate', () => {
    expect(links).toHaveLength(EXPECTED.length);
    EXPECTED.forEach((want, i) => {
      const got = links[i];
      expect(got.group, `row ${i} group placement`).toBe(want.group);
      expect(got.href, `row ${i} href`).toBe(want.href);
      expect(got.labelKey, `${want.href} labelKey`).toBe(want.labelKey);
      expect(got.icon, `${want.href} icon ref`).toBe(want.icon);
      // The pre-rung-4 row was manager-up (managers/admins see Manage → Performance) and never
      // adminOnly — employees reach their own reviews via /me, not this row.
      expect(got.managerUp, `${want.href} managerUp`).toBe(true);
      expect(got.adminOnly, `${want.href} adminOnly`).toBeUndefined();
    });
  });

  it('declares no collapsible nav node (performance is a flat row by design)', () => {
    expect(performancePack.nav).toBeUndefined();
  });

  it('sidebar.tsx mounts the row via the registry and hardcodes it nowhere', () => {
    const sidebar = fs.readFileSync(path.resolve(__dirname, '../components/sidebar.tsx'), 'utf8');
    // The registration moved out of the sidebar into packs/register-all.ts (ADR-0077 slice 1) so that
    // SERVER code can enumerate module packs too — a client-component side effect left listPacks()
    // empty on the server. The property under test is unchanged and still end-to-end: the pack is
    // registered, AND the sidebar pulls in the file that registers it. Asserting only the first half
    // would pass with the sidebar importing nothing at all.
    const registerAll = fs.readFileSync(path.resolve(__dirname, '../packs/register-all.ts'), 'utf8');
    expect(registerAll, 'registers the pack (static side-effect import)').toContain(`import '@/packs/performance'`);
    expect(sidebar, 'sidebar pulls in the shared pack wiring').toContain(`import '@/packs/register-all'`);
    expect(sidebar, 'resolves the row through the registry').toContain(`modulePackById('performance')`);
    for (const { href } of EXPECTED) {
      expect(sidebar.includes(`'${href}'`), `${href} no longer hardcoded in sidebar.tsx`).toBe(false);
    }
  });
});

describe('ADR-0080 rung 4: service facade re-exports the implementation unchanged', () => {
  it('exposes the exact same function references as core/performance', () => {
    // Representatives across the module's slices (cycle lifecycle, reviews, comp seam, goals,
    // check-ins, 360°, calibration, attachments, AI draft, vocabulary); identity (toBe) proves
    // the facade cannot change behaviour for callers that switched paths.
    expect(facade.createCycle).toBe(corePerformance.createCycle);
    expect(facade.openCycle).toBe(corePerformance.openCycle);
    expect(facade.releaseCycle).toBe(corePerformance.releaseCycle);
    expect(facade.closeCycle).toBe(corePerformance.closeCycle);
    expect(facade.submitSelfReview).toBe(corePerformance.submitSelfReview);
    expect(facade.submitManagerReview).toBe(corePerformance.submitManagerReview);
    expect(facade.acknowledgeReview).toBe(corePerformance.acknowledgeReview);
    expect(facade.reassignReviewer).toBe(corePerformance.reassignReviewer);
    expect(facade.enactCompAction).toBe(corePerformance.enactCompAction);
    expect(facade.declineCompAction).toBe(corePerformance.declineCompAction);
    expect(facade.listCycles).toBe(corePerformance.listCycles);
    expect(facade.cycleDetail).toBe(corePerformance.cycleDetail);
    expect(facade.reviewForViewer).toBe(corePerformance.reviewForViewer);
    expect(facade.myReviews).toBe(corePerformance.myReviews);
    expect(facade.managerPendingReviews).toBe(corePerformance.managerPendingReviews);
    expect(facade.createGoal).toBe(corePerformance.createGoal);
    expect(facade.updateGoalProgress).toBe(corePerformance.updateGoalProgress);
    expect(facade.myGoals).toBe(corePerformance.myGoals);
    expect(facade.scheduleCheckIn).toBe(corePerformance.scheduleCheckIn);
    expect(facade.myCheckIns).toBe(corePerformance.myCheckIns);
    expect(facade.requestPeerFeedback).toBe(corePerformance.requestPeerFeedback);
    expect(facade.submitPeerFeedback).toBe(corePerformance.submitPeerFeedback);
    expect(facade.myFeedbackRequests).toBe(corePerformance.myFeedbackRequests);
    expect(facade.peerFeedbackForReview).toBe(corePerformance.peerFeedbackForReview);
    expect(facade.openCalibrationSession).toBe(corePerformance.openCalibrationSession);
    expect(facade.commitCalibration).toBe(corePerformance.commitCalibration);
    expect(facade.calibrationView).toBe(corePerformance.calibrationView);
    expect(facade.addPerformanceAttachment).toBe(corePerformance.addPerformanceAttachment);
    expect(facade.getPerformanceAttachment).toBe(corePerformance.getPerformanceAttachment);
    expect(facade.draftManagerReview).toBe(corePerformance.draftManagerReview);
    // The debt-table helper (core/employment-review.ts's one import) and shared vocabulary.
    expect(facade.currentAdminManager).toBe(corePerformance.currentAdminManager);
    expect(facade.serviceMonths).toBe(corePerformance.serviceMonths);
    expect(facade.evaluateEligibility).toBe(corePerformance.evaluateEligibility);
    expect(facade.cycleStages).toBe(corePerformance.cycleStages);
    expect(facade.DEFAULT_RATING_SCALE).toBe(corePerformance.DEFAULT_RATING_SCALE);
    expect(facade.PerfError).toBe(corePerformance.PerfError);
  });
});
