/**
 * The review journey's module offer and IDP lock, as navigation reads them (pure).
 *
 * The lock is reviewWorkspaceParts' own (packs/performance/onehr/workspace-model.ts): the person's IDP stays
 * locked while their own KPI part or assigned competency self-assessment is open or waiting. 360 feedback never
 * blocks, a part with nothing assigned never blocks, and a team view never carries the lock. The sidebar offer
 * (workspaceNavigationOffer) and the page's module resolution (resolveWorkspaceSelection) both read that flag.
 */
import { describe, expect, it } from 'vitest';
import { defaultPolicy, type KPI } from '../packs/performance/onehr/model';
import framework from '../packs/performance/onehr/framework.json';
import { resolveWorkspaceSelection, reviewWorkspaceParts, workspaceNavigationOffer, type ReviewWorkFacts, type WorkspaceSelectionItem } from '../packs/performance/onehr/workspace-model';

const policy = defaultPolicy(framework);
const approved = { id: 'delivery', hrOwned: false, setting: 'approved', moderatorEmploymentId: 'manager', approvalChain: [{ employmentId: 'manager', actual: null, remark: '', at: null }], locked: false } as KPI;
const base: ReviewWorkFacts = { kpis: [approved], competenciesAssigned: true, competencyStatus: 'pending', resultsSubmitted: false, managerPerformance: null, planStatus: null };
const self = { self: true, manager: false, employmentIds: ['employee'] };
const manager = { self: false, manager: true, employmentIds: ['manager'] };
/** Worklist items for one review, shaped as performanceWorkspace shapes them. */
const items = (facts: ReviewWorkFacts, actor = self, cycleId = 'cycle'): WorkspaceSelectionItem[] =>
  reviewWorkspaceParts(policy, facts, actor).map(part => ({ cycleId, view: actor.self ? 'mine' : 'team', module: part.module, state: part.state, locked: part.locked }));
const idp = (facts: ReviewWorkFacts, actor = self) => reviewWorkspaceParts(policy, facts, actor).find(part => part.module === 'idp');

describe('IDP lock (the reference rule)', () => {
  it('locks the plan while the employee KPI part is open', () => {
    expect(idp(base)).toMatchObject({ locked: true, state: 'later' });
    expect(workspaceNavigationOffer(items(base))).toEqual({ tm: true, idp: 'locked' });
  });
  it('stays locked when the KPI part is done but the competency self-assessment is open', () => {
    const facts = { ...base, resultsSubmitted: true };
    expect(reviewWorkspaceParts(policy, facts, self).find(part => part.module === 'pm')?.state).toBe('done');
    expect(idp(facts)?.locked).toBe(true);
    expect(workspaceNavigationOffer(items(facts)).idp).toBe('locked');
  });
  it('opens once both are done (submitted is done for the person; the manager step does not hold it)', () => {
    const facts = { ...base, resultsSubmitted: true, competencyStatus: 'submitted' };
    expect(idp(facts)).toMatchObject({ locked: false, state: 'open' });
    expect(workspaceNavigationOffer(items(facts))).toEqual({ tm: true, idp: 'open' });
  });
  it('does not let an unassigned competency part block', () => {
    const facts = { ...base, resultsSubmitted: true, competenciesAssigned: false };
    expect(idp(facts)?.locked).toBe(false);
    expect(workspaceNavigationOffer(items(facts))).toEqual({ tm: false, idp: 'open' });
  });
  it('does not let a switched-off module block', () => {
    expect(reviewWorkspaceParts({ ...policy, modules: { ...policy.modules, pm: false, tm: false } }, base, self).find(part => part.module === 'idp')?.locked).toBe(false);
  });
  it('never shows the lock in a team view', () => {
    expect(idp(base, manager)?.locked).toBe(false);
    expect(workspaceNavigationOffer(items(base, manager))).toEqual({ tm: true, idp: 'open' });
  });
  it('does not let 360 feedback (a TM item of the rater) block or unlock the plan', () => {
    const feedback: WorkspaceSelectionItem = { cycleId: 'cycle', view: 'mine', module: 'tm', state: 'open', locked: false };
    expect(workspaceNavigationOffer([...items({ ...base, resultsSubmitted: true, competencyStatus: 'submitted' }), feedback]).idp).toBe('open');
    expect(workspaceNavigationOffer([...items(base), feedback]).idp).toBe('locked');
  });
  it('offers the plan as a link when the own plan is locked but a team plan is reviewable', () => {
    expect(workspaceNavigationOffer([...items(base), ...items(base, manager)]).idp).toBe('open');
  });
});

describe('module offer', () => {
  const calibration: WorkspaceSelectionItem[] = [{ cycleId: 'cycle', view: 'bu', module: 'cal', state: 'open', locked: false }, { cycleId: 'cycle', view: 'bu', module: 'cal', state: 'open', locked: false }];
  it('offers a calibration-only reviewer only calibration: no Talent, no Development', () => {
    expect(workspaceNavigationOffer(calibration)).toEqual({ tm: false, idp: 'none' });
    expect(resolveWorkspaceSelection(calibration, { module: 'idp' })).toMatchObject({ view: 'bu', availableModules: ['cal'], module: 'cal' });
    expect(resolveWorkspaceSelection(calibration, { module: 'tm' }).module).toBe('cal');
    expect(resolveWorkspaceSelection(calibration, { module: 'pm' }).module).toBe('cal');
  });
  it('offers nothing to a viewer without work', () => {
    expect(workspaceNavigationOffer([])).toEqual({ tm: false, idp: 'none' });
    expect(resolveWorkspaceSelection([], { module: 'idp' })).toMatchObject({ cycle: undefined, view: 'mine', module: 'pm', availableModules: [] });
  });
});

describe('workspace module resolution', () => {
  it('does not select a locked plan from a crafted request; it falls back to the open work', () => {
    const own = items(base);
    const picked = resolveWorkspaceSelection(own, { module: 'idp' });
    expect(picked.module).toBe('pm');
    expect(picked.lockedModules).toEqual(['idp']);
    expect(resolveWorkspaceSelection(items({ ...base, resultsSubmitted: true }), { module: 'idp' }).module).toBe('tm');
  });
  it('selects the plan once it opens', () => {
    expect(resolveWorkspaceSelection(items({ ...base, resultsSubmitted: true, competencyStatus: 'submitted' }), { module: 'idp' })).toMatchObject({ module: 'idp', lockedModules: [] });
  });
  it('resumes at the first module with open work when no module is requested', () => {
    const facts = { ...base, resultsSubmitted: true };
    expect(resolveWorkspaceSelection(items(facts), {}).module).toBe('tm');
    expect(resolveWorkspaceSelection(items({ ...base, resultsSubmitted: true, competencyStatus: 'submitted', planStatus: 'shared' }), {}).module).toBe('pm');
  });
  it('lands an old link for a module held in another view of the cycle in that view', () => {
    const both = [...items(base), ...items({ ...base, resultsSubmitted: true, competencyStatus: 'submitted' }, manager)];
    expect(resolveWorkspaceSelection(both, { module: 'idp' })).toMatchObject({ view: 'team', module: 'idp' });
    expect(resolveWorkspaceSelection(both, { view: 'mine', module: 'idp' })).toMatchObject({ view: 'team', module: 'idp' });
    expect(resolveWorkspaceSelection(both, { view: 'mine' })).toMatchObject({ view: 'mine', module: 'pm' });
    expect(resolveWorkspaceSelection(both, {})).toMatchObject({ view: 'mine' });
  });
  it('keeps an explicit view when the requested module is held nowhere', () => {
    expect(resolveWorkspaceSelection(items(base, manager), { view: 'team', module: 'cal' })).toMatchObject({ view: 'team', module: 'pm' });
  });
  it('without a cycle, lands in the first cycle that holds the requested module', () => {
    const later = items({ ...base, competenciesAssigned: false }, self, 'later');
    const earlier = items(base, manager, 'earlier');
    expect(resolveWorkspaceSelection([...later, ...earlier], { module: 'tm' })).toMatchObject({ cycle: 'earlier', view: 'team', module: 'tm' });
    expect(resolveWorkspaceSelection([...later, ...earlier], { cycle: 'later', module: 'tm' })).toMatchObject({ cycle: 'later', module: 'pm' });
    expect(resolveWorkspaceSelection([...later, ...earlier], {}).cycle).toBe('later');
  });
});
