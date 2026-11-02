import { describe, expect, it, vi } from 'vitest';
import { createInAppAlertState, type AlertScope } from '../mobile/lib/in-app-alert-state';

function fixture() {
  const state = createInAppAlertState();
  let scope: AlertScope = { generation: 1, route: '/approvals/leave/id', employmentId: 'employment-A', active: true };
  const detach = state.attach(() => scope);
  const confirm = vi.fn(), cancel = vi.fn();
  const show = () => state.show('Approve leave?', 'Dates and reason', [{ text: 'Cancel', style: 'cancel', onPress: cancel }, { text: 'Approve', onPress: confirm }]);
  return { state, show, confirm, cancel, detach, setScope: (patch: Partial<AlertScope>) => { scope = { ...scope, ...patch }; } };
}

describe('same-window confirmation ownership', () => {
  it('never confirms on presentation; Cancel and Back take only the cancel path', () => {
    const f = fixture(); f.show(); expect(f.confirm).not.toHaveBeenCalled();
    f.state.dismiss(); expect(f.cancel).toHaveBeenCalledTimes(1); expect(f.confirm).not.toHaveBeenCalled(); expect(f.state.getSnapshot()).toBeNull();
  });
  it('consumes a confirmation before its callback, preventing duplicate or retained taps', () => {
    const f = fixture(); f.show(); const id = f.state.getSnapshot()!.id;
    f.state.press(id, 1); f.state.press(id, 1);
    expect(f.confirm).toHaveBeenCalledTimes(1); expect(f.state.getSnapshot()).toBeNull();
    f.show(); f.state.press(id, 1); expect(f.confirm).toHaveBeenCalledTimes(1); expect(f.state.getSnapshot()).not.toBeNull();
  });
  it.each<Partial<AlertScope>>([{ generation: 2 }, { route: '/me' }, { employmentId: 'employment-B' }, { active: false }])('refuses stale confirmations after a scope change: %j', patch => {
    const f = fixture(); f.show(); const id = f.state.getSnapshot()!.id; f.setScope(patch); f.state.press(id, 1);
    expect(f.confirm).not.toHaveBeenCalled(); expect(f.state.getSnapshot()).toBeNull();
  });
  it('clears sensitive dialog text when the protected shell unmounts and never replays it in another host', () => {
    const f = fixture(); f.show(); const id = f.state.getSnapshot()!.id; f.detach();
    expect(f.state.getSnapshot()).toBeNull();
    f.state.attach(() => ({ generation: 2, route: '/me', employmentId: 'employment-B', active: true }));
    f.state.press(id, 1); expect(f.confirm).not.toHaveBeenCalled();
  });
  it('does not queue confirmations before the unlocked host exists or behind another confirmation', () => {
    const state = createInAppAlertState(); state.show('No host'); expect(state.getSnapshot()).toBeNull();
    const f = fixture(); f.show(); const first = f.state.getSnapshot(); f.state.show('Different action'); expect(f.state.getSnapshot()).toBe(first);
    f.state.clear(); expect(f.confirm).not.toHaveBeenCalled(); expect(f.cancel).not.toHaveBeenCalled();
  });
  it('reconciles route changes without executing any button callback', () => {
    const f = fixture(); f.show(); f.setScope({ route: '/clock' }); f.state.reconcile();
    expect(f.state.getSnapshot()).toBeNull(); expect(f.confirm).not.toHaveBeenCalled(); expect(f.cancel).not.toHaveBeenCalled();
  });
  it('rechecks ownership after synchronous dismissal listeners before invoking an action', () => {
    const f = fixture(); f.show(); const id = f.state.getSnapshot()!.id;
    f.state.subscribe(() => { if (!f.state.getSnapshot()) f.setScope({ generation: 3 }); });
    f.state.press(id, 1); expect(f.confirm).not.toHaveBeenCalled();
  });
});
