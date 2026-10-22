import { describe, expect, it } from 'vitest';
import { recordedAttendanceProgress, type AttendanceProgressWorkflow } from '../lib/attendance-progress';
import { attendanceReviewEvidence, originalAttendanceReview } from '../lib/attendance-review-evidence';

const actor = (id: string, slot: string) => ({ kind: 'specific_employee' as const, name: `Frozen ${id}`, employmentId: id, personId: `person-${id}`, slot });
const identities = new Map(['A', 'B', 'C'].map(id => [id, { employeeCode: `ID-${id}`, eligible: true }]));
function flow(mode: 'sequential' | 'any_one' = 'sequential'): AttendanceProgressWorkflow {
  return { routingVersion: 3, currentStage: 0, decisions: [], participantDecisions: [], stages: [
    { name: 'Saved level', mode, approvers: [actor('A', '0:0'), actor('B', '0:1')] },
    { name: 'Saved next level', mode: 'any_one', approvers: [actor('C', '1:0')] },
  ] };
}
describe('Recorded approval progress', () => {
  it('an intermediate participant approval leaves the application pending and advances only within that level', () => {
    const f = flow();
    f.participantDecisions = [{ stageIndex: 0, participantSlot: '0:0', decision: 'approved', actualPersonId: 'person-A' }];
    expect(recordedAttendanceProgress(f, 'pending', identities)).toMatchObject({ state: 'pending', level: 1, mode: 'sequential', next: [{ name: 'Frozen B', employeeCode: 'ID-B', eligible: true }] });
  });
  it('v4 all-required exposes all unfinished slots and keeps remaining people visible after an out-of-order decision',()=>{
    const f=flow();f.routingVersion=4;f.stages[0].mode='all_required';
    expect(recordedAttendanceProgress(f,'pending',identities)).toMatchObject({state:'pending',mode:'all_required',next:[{name:'Frozen A'},{name:'Frozen B'}]});
    f.participantDecisions=[{stageIndex:0,participantSlot:'0:1',decision:'approved',actualPersonId:'person-B'}];
    expect(recordedAttendanceProgress(f,'pending',identities)).toMatchObject({state:'pending',mode:'all_required',level:1,next:[{name:'Frozen A'}]});
  });
  it('any-one mode shows all saved eligible candidates; a later level is never shown early', () => {
    const p = recordedAttendanceProgress(flow('any_one'), 'pending', identities);
    expect(p.next.map(a => a.name)).toEqual(['Frozen A', 'Frozen B']); expect(p.level).toBe(1);
  });
  it.each(['approved', 'rejected', 'cancelled', 'withdrawn'])('a final %s outcome never displays a next approver', status => {
    expect(recordedAttendanceProgress(flow(), status, identities)).toMatchObject({ state: 'final', level: null, next: [] });
  });
  it('does not skip an ineligible first sequential person or substitute a current template', () => {
    const blocked = new Map(identities); blocked.set('A', { employeeCode: 'ID-A', eligible: false });
    const p = recordedAttendanceProgress(flow(), 'pending', blocked);
    expect(p.state).toBe('unresolved'); expect(p.next.map(a => a.name)).toEqual(['Frozen A']);
  });
  it('uses recorded reassignment instead of the original slot while preserving the original input', () => {
    const f = flow(); f.effectiveStages = [{ ...f.stages[0], approvers: [actor('C', '0:0'), actor('B', '0:1')] }, f.stages[1]];
    expect(recordedAttendanceProgress(f, 'pending', identities).next[0].name).toBe('Frozen C');
    expect(f.stages[0].approvers[0].name).toBe('Frozen A');
  });
  it('does not represent one person as eligible to decide a second distinct level', () => {
    const f = flow(); f.currentStage = 1; f.stages[1].approvers = [actor('A', '1:0')];
    f.decisions = [{ stageIndex: 0, decision: 'approved', actualPersonId: 'person-A' }];
    expect(recordedAttendanceProgress(f, 'pending', identities).state).toBe('unresolved');
  });
  it('missing or inconsistent routing stays explicitly unresolved', () => {
    expect(recordedAttendanceProgress(null, 'pending').state).toBe('legacy');
    const f = flow(); f.currentStage = 99;
    expect(recordedAttendanceProgress(f, 'pending', identities)).toMatchObject({ state: 'unresolved', next: [] });
  });
});
describe('Attendance evidence is read, never reconstructed', () => {
  it('keeps zero distinct from absent and invalid measurements', () => {
    expect(attendanceReviewEvidence({ workedMinutes: 0, underMinutes: 0 })).toMatchObject({ worked: 0, shortfall: 0, required: null });
    expect(attendanceReviewEvidence({ workedMinutes: -1, underMinutes: '0' })).toMatchObject({ worked: null, shortfall: null });
    expect(attendanceReviewEvidence(null)).toBeNull(); expect(attendanceReviewEvidence(undefined)).toBeUndefined();
  });
  it('uses immutable before evidence and does not confuse an absent prior row with unrecorded history', () => {
    expect(originalAttendanceReview([])).toBeUndefined();
    expect(originalAttendanceReview([{ eventType: 'attendance-correction.effect.recorded', payload: { before: null } }])).toBeNull();
    const before = originalAttendanceReview([{ eventType: 'attendance.amended', payload: { before: { checkInAt: '09:30:00', workedMinutes: 390, underMinutes: 90 }, after: { workedMinutes: 480, underMinutes: 0 } } }]);
    expect(before).toMatchObject({ checkIn: '09:30:00', worked: 390, shortfall: 90 });
  });
  it('a legacy clock snapshot supplies only its recorded clock values', () => {
    expect(originalAttendanceReview([], { attendanceId: 'existing', originalCheckIn: '09:30:00', originalCheckOut: null })).toMatchObject({ checkIn: '09:30:00', checkOut: null, worked: null, required: null });
  });
});
