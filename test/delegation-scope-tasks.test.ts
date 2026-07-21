/**
 * R51 (20f09fc3) — leave TASK TREE in the delegation scope registry. Pure tests (no DB):
 *   • registry integrity — the three new request-side leaves are real leaves of the leave module;
 *   • guard separation — group ids are NOT task types (leaf-only storage depends on this), and the group
 *     guard accepts exactly the group ids;
 *   • expandScopeTasks — the bare-group-covers-all rule, per-group narrowing, and the mixed-selection
 *     mainline (bare group + sibling flat leaf loses nothing);
 *   • formatDelegationScope — stored leaf rows render with the new task labels (groups never reach storage).
 */
import { describe, expect, it } from 'vitest';
import {
  DELEGATION_SCOPE_GROUPS,
  expandScopeTasks,
  isDelegationScopeGroup,
  isDelegationTaskType,
  moduleOfTask,
  taskLabelKey,
  type DelegationTaskType,
} from '../lib/delegation-scope';
import { formatDelegationScope } from '../lib/delegation-format';

const NEW_LEAVES: DelegationTaskType[] = [
  'leave.request.creation',
  'leave.request.amendment',
  'leave.cancellation_request.creation',
];

describe('delegation scope registry — leave task tree (R51 20f09fc3)', () => {
  it('each new leaf is a leave-module task with a label key', () => {
    for (const leaf of NEW_LEAVES) {
      expect(moduleOfTask[leaf]).toBe('leave');
      expect(taskLabelKey[leaf]).toBeTruthy();
      expect(isDelegationTaskType(leaf)).toBe(true);
    }
    // The label keys are the agreed flat i18n suffixes.
    expect(taskLabelKey['leave.request.creation']).toBe('leaveRequestCreation');
    expect(taskLabelKey['leave.request.amendment']).toBe('leaveAmendmentRequest');
    expect(taskLabelKey['leave.cancellation_request.creation']).toBe('leaveCancellationRequest');
  });

  it('the existing approval leaves are untouched', () => {
    expect(moduleOfTask['leave.application']).toBe('leave');
    expect(moduleOfTask['leave.cancellation']).toBe('leave');
    expect(taskLabelKey['leave.application']).toBe('leaveApplication');
    expect(taskLabelKey['leave.cancellation']).toBe('leaveCancellation');
  });

  it('group ids are groups, NOT task types (guard separation pins leaf-only storage)', () => {
    for (const gid of ['leave.request', 'leave.cancellation_request']) {
      expect(isDelegationScopeGroup(gid)).toBe(true);
      expect(isDelegationTaskType(gid)).toBe(false);
    }
    // And leaves are not groups.
    expect(isDelegationScopeGroup('leave.request.creation')).toBe(false);
    expect(isDelegationScopeGroup('leave.application')).toBe(false);
  });

  it('the leave groups expand to the agreed leaves', () => {
    const groups = DELEGATION_SCOPE_GROUPS.leave ?? [];
    expect(groups.map((g) => g.id)).toEqual(['leave.request', 'leave.cancellation_request']);
    expect(groups[0].leaves).toEqual(['leave.request.creation', 'leave.request.amendment']);
    expect(groups[1].leaves).toEqual(['leave.cancellation_request.creation']);
    expect(groups[0].labelKey).toBe('leaveRequest');
    expect(groups[1].labelKey).toBe('leaveCancellation');
  });
});

describe('expandScopeTasks', () => {
  it('a bare group covers ALL of its leaves', () => {
    expect(expandScopeTasks(['leave.request'], []).sort()).toEqual(
      ['leave.request.amendment', 'leave.request.creation'].sort(),
    );
    expect(expandScopeTasks(['leave.cancellation_request'], [])).toEqual(['leave.cancellation_request.creation']);
  });

  it('mixed-selection mainline: bare group + sibling FLAT leaf yields all three leaves (nothing dropped)', () => {
    const out = expandScopeTasks(['leave.request'], ['leave.application']).sort();
    expect(out).toEqual(['leave.application', 'leave.request.amendment', 'leave.request.creation'].sort());
  });

  it('a group with a SUBSET of its own leaves narrows to just those', () => {
    expect(expandScopeTasks(['leave.request'], ['leave.request.creation'])).toEqual(['leave.request.creation']);
  });

  it('group ids arriving as tasks are ignored; unknown groups are ignored; output de-dupes', () => {
    // A forged/stale scopeTask carrying a group id never becomes a leaf.
    expect(expandScopeTasks([], ['leave.request' as unknown as DelegationTaskType])).toEqual([]);
    expect(expandScopeTasks(['nope' as never], ['leave.application'])).toEqual(['leave.application']);
    expect(
      expandScopeTasks(['leave.request', 'leave.request'], ['leave.request.amendment', 'leave.request.amendment']),
    ).toEqual(['leave.request.amendment']);
  });

  it('both groups bare together cover all five request-side leaves… i.e. all three leaves', () => {
    const out = expandScopeTasks(['leave.request', 'leave.cancellation_request'], []).sort();
    expect(out).toEqual(
      ['leave.cancellation_request.creation', 'leave.request.amendment', 'leave.request.creation'].sort(),
    );
  });
});

describe('formatDelegationScope renders the new leaf labels', () => {
  // The page passes next-intl's t; here a transparent fake that returns the key suffix.
  const t = (key: string) => `L(${key})`;

  it('stored leaf rows resolve through taskLabelKey', () => {
    const out = formatDelegationScope(
      [
        { module: 'leave', taskType: 'leave.request.creation' },
        { module: 'leave', taskType: 'leave.request.amendment' },
        { module: 'leave', taskType: 'leave.cancellation_request.creation' },
        { module: 'leave', taskType: 'leave.application' },
      ],
      t,
    );
    expect(out).toBe(
      'L(taskLabel.leaveRequestCreation), L(taskLabel.leaveAmendmentRequest), L(taskLabel.leaveCancellationRequest), L(taskLabel.leaveApplication)',
    );
  });

  it('whole-module and whole-scope copy are unchanged', () => {
    expect(formatDelegationScope([], t)).toBe('L(allApprovals)');
    expect(formatDelegationScope([{ module: 'leave', taskType: null }], t)).toBe('L(wholeModule)');
  });
});
