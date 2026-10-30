import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
const owner = vi.hoisted(() => ({
  admin: true, holidayGroups: vi.fn(), calendars: vi.fn(), schedule: vi.fn(), rules: vi.fn(),
  positions: vi.fn(), units: vi.fn(), locations: vi.fn(), currency: vi.fn(),
  dependents: vi.fn(), qualifications: vi.fn(), contacts: vi.fn(), superiors: vi.fn(),
}));
vi.mock('../lib/authz', () => ({isAdmin: () => owner.admin}));
vi.mock('../core/read', () => ({directSuperiorHistoryFor: owner.superiors, getCompanyCurrency: owner.currency}));
vi.mock('../core/admin', () => ({listHolidayGroups: owner.holidayGroups, listPositions: owner.positions, listBusinessUnits: owner.units}));
vi.mock('../core/holiday-calendar-assignment', () => ({employmentHolidayCalendarHistory: owner.calendars}));
vi.mock('../core/roster', () => ({employmentScheduleGroupId: owner.schedule}));
vi.mock('../packs/attendance/service', () => ({listAttendanceRules: owner.rules}));
vi.mock('../core/location', () => ({listLocations: owner.locations}));
vi.mock('../core/dependents', () => ({listDependents: owner.dependents}));
vi.mock('../core/qualifications', () => ({listQualifications: owner.qualifications}));
vi.mock('../core/emergency-contacts', () => ({listEmergencyContacts: owner.contacts}));
import {personnelDetailSupport} from '../core/personnel-detail-support';
const ctx = {tenantId: 'tenant-a', userId: 'hr-a', roles: ['hr_admin']};
const subject = {employmentId: 'employment-a', personId: 'person-a', companyId: 'company-a'};
const readers = () => [owner.holidayGroups, owner.calendars, owner.schedule, owner.rules, owner.positions,
  owner.units, owner.locations, owner.currency, owner.dependents, owner.qualifications, owner.contacts, owner.superiors];
beforeEach(() => {
  vi.resetAllMocks(); owner.admin = true;
  for (const reader of readers()) reader.mockResolvedValue([]);
  owner.schedule.mockResolvedValue('schedule-a'); owner.currency.mockResolvedValue('MYR');
});
afterEach(() => vi.useRealTimers());
describe('HR employee record support reads', () => {
  it('loads twelve independent owners in three windows, with at most four active reads', async () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-30T00:00:00Z'));
    let active = 0, peak = 0;
    for (const [i, reader] of readers().entries()) reader.mockImplementation(() => {
      active++; peak = Math.max(peak, active);
      return new Promise(resolve => setTimeout(() => {active--; resolve(i);}, 20));
    });
    const start = Date.now(), result = personnelDetailSupport(ctx, subject);
    await vi.runAllTimersAsync();
    expect(await result).toEqual({holidayGroups: 0, holidayCalendarRows: 1, scheduleGroupCurrentId: 2,
      attendanceRules: 3, positions: 4, businessUnits: 5, locations: 6, defaultSalaryCurrency: 7,
      dependents: 8, qualifications: 9, emergencyContacts: 10, superiorHistory: 11});
    expect(Date.now() - start).toBe(60); expect(peak).toBe(4); expect(active).toBe(0);
  });
  it('keeps the session, employment, person and company scope at each owner', async () => {
    await personnelDetailSupport(ctx, subject);
    for (const reader of readers()) {expect(reader).toHaveBeenCalledOnce(); expect(reader.mock.calls[0][0]).toBe(ctx);}
    for (const reader of [owner.calendars, owner.schedule, owner.superiors]) expect(reader).toHaveBeenCalledWith(ctx, subject.employmentId);
    for (const reader of [owner.dependents, owner.contacts]) expect(reader).toHaveBeenCalledWith(ctx, {personId: subject.personId});
    expect(owner.qualifications).toHaveBeenCalledWith(ctx, {employmentId: subject.employmentId});
    for (const reader of [owner.positions, owner.units]) expect(reader).toHaveBeenCalledWith(ctx, {companyIds: [subject.companyId]});
    expect(owner.locations).toHaveBeenCalledWith(ctx, [subject.companyId]);
    expect(owner.currency).toHaveBeenCalledWith(ctx, subject.companyId);
  });
  it('does not load HR-only support data for a non-admin', async () => {
    owner.admin = false;
    const result = await personnelDetailSupport({...ctx, roles: ['manager']}, subject);
    for (const reader of readers()) expect(reader).not.toHaveBeenCalled();
    expect(result).toMatchObject({dependents: [], qualifications: [], emergencyContacts: [], defaultSalaryCurrency: 'MYR', scheduleGroupCurrentId: null});
  });
  it('propagates an owner failure and does not launch later batches', async () => {
    owner.calendars.mockRejectedValueOnce(Error('owner unavailable'));
    await expect(personnelDetailSupport(ctx, subject)).rejects.toThrow('owner unavailable');
    for (const reader of [owner.positions, owner.units, owner.locations, owner.currency, owner.dependents, owner.contacts]) expect(reader).not.toHaveBeenCalled();
  });
});
