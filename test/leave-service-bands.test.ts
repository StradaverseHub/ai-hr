/**
 * Leave Entitlement Rules Engine (feedback a0228655) — service-length bands above the flat annualDays,
 * the one-active-default-per-type supersede fix, and the pure preview resolver.
 *
 * Pure-resolver unit tests exercise core/leave-compute.ts directly (bandDaysFor, resolveGradePolicy with
 * bands, previewEntitlement) — no DB needed. Integration tests exercise the full stack (hire grant,
 * openLeaveYear, accrueEarnedLeave, expireCarriedLeave, admin.ts validation + supersede + tri-state).
 */
import { and, eq, sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as schema from '../db/schema';
import { hireEmployee } from '../core/org';
import { createJobGrade,  deleteLeavePolicy, updateLeavePolicy } from '../core/admin';
import { accrueEarnedLeave, expireCarriedLeave, openLeaveYear } from '../core/leave';
import { leaveEntitlementBreakdown } from '../core/read';
import {
  applyMaxBalance,
  bandCarryExpiry,
  bandCarryMax,
  bandDaysFor,
  bandFor,
  bandMaxBalance,
  hasAnyCarryExpiry,
  // 6e9a126e — the band ceiling, imported rather than restated, so this test moves with the constant.
  isWellFormedBands,
  MAX_SERVICE_BANDS,
  previewEntitlement,
  resolveGradePolicy,
  type AccrualConfig,
  type GradePolicyRow,
  type ServiceBand,
} from '../core/leave-compute';
import { adminCtx, closeAll, eventTypesFor, ledgerBalance, migrateTestDb, owner, resetDb, seedBase, type Base , seedEntitlement } from './harness';