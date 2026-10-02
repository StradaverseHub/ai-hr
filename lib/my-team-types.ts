/** Serializable My Team projection: source owners calculate, this contract only presents. */
export type MyTeamScopeMode = 'direct' | 'all' | 'department';
export type MyTeamTile = 'members' | 'checked_in' | 'late' | 'absent' | 'on_leave' | 'pending_approvals';
export type MyTeamLayers = { roster: boolean; attendance: boolean; leave: boolean };
export type MyTeamQuery = {
  view: 'week' | 'month'; anchorDate?: string; scope: MyTeamScopeMode;
  companyIds?: string[]; departmentId?: string; search?: string; tile?: MyTeamTile;
  layers?: MyTeamLayers; locale?: string;
  /** A narrowing request only: always intersected with freshly authorized team membership. */
  employmentId?: string;
};
export type MyTeamNormalizedQuery = MyTeamQuery & { anchorDate: string; companyIds: string[]; search: string; layers: MyTeamLayers };
export type MyTeamSourceAvailability = 'available' | 'unavailable';
export type MyTeamRosterDay = {
  shiftId: string | null; code: string | null; name: string | null; color: string | null;
  start: string | null; end: string | null; scheduledMinutes: number | null;
  isRestDay: boolean; isOverride: boolean;
};
export type MyTeamAttendanceDay = {
  attendanceId: string | null; status: string; flag: string | null;
  checkInAt: string | null; checkOutAt: string | null; workedMinutes: number | null;
  lateMinutes: number | null; scheduledMinutes: number | null; fingerprint: string | null;
  reviewed: boolean;
};
export type MyTeamLeaveDay = {
  requestId: string; leaveTypeId: string; code: string; name: string; color: string | null;
  status: 'approved' | 'pending'; session: 'full_day' | 'AM' | 'PM' | 'hourly';
  days: number; fromTime: string | null; toTime: string | null;
};
export type MyTeamDay = { date: string; roster: MyTeamRosterDay | null; attendance: MyTeamAttendanceDay | null; leave: MyTeamLeaveDay[] };
export type MyTeamBalance = {
  leaveTypeId: string; code: string | null; name: string; role: string | null;
  accrued: number | null; taken: number | null; pending: number | null; available: number | null;
};
export type MyTeamWeekSummary = {
  from: string; to: string; checkedInDays: number; absentDays: number;
  lateMinutes: number | null; workedMinutes: number | null;
};
export type MyTeamTodayFlags = { checkedIn: boolean; late: boolean; absent: boolean; onLeave: boolean; halfDayLeave: boolean; pendingApprovals: boolean };
export type MyTeamEmployee = {
  employmentId: string; employeeCode: string | null; name: string; occupation: string | null;
  companyId: string; departmentId: string | null;
  annualAvailable: number | null; balances: MyTeamBalance[];
  days: MyTeamDay[]; weeks: MyTeamWeekSummary[]; today: MyTeamTodayFlags;
};
export type MyTeamApproval = {
  requestId: string; employmentId: string; employeeName: string;
  leaveTypeId: string; leaveType: string; startDate: string; endDate: string; days: number;
  appliedAt: string; annualAvailable: number | null; dateDecisionRequired: boolean;
  dates: { date: string; days: number; status: string }[];
};
export type MyTeamAttention =
  | { kind: 'pending_leave'; id: string; employmentId: string; approval: MyTeamApproval }
  | { kind: 'absent' | 'late'; id: string; employmentId: string; date: string; lateMinutes: number | null; pendingLeave: boolean }
  | { kind: 'missing_punch'; id: string; employmentId: string; date: string; attendanceId: string; fingerprint: string };
export type MyTeamSnapshot = {
  query: MyTeamNormalizedQuery; today: string;
  period: { from: string; to: string; gridDates: string[]; coveringWeeks: { from: string; to: string }[] };
  scope: { employmentIds: string[]; companies: { id: string; name: string }[]; departments: { id: string; companyId: string; name: string }[]; canEditRoster: boolean };
  availability: { attendance: MyTeamSourceAvailability; leave: MyTeamSourceAvailability; roster: MyTeamSourceAvailability };
  /** Whole authorized scope supplies fixed tiles/attention/panel. Search and tile narrow only grid IDs. */
  employees: MyTeamEmployee[]; gridEmploymentIds: string[];
  todaySummary: { members: number; checkedIn: number | null; late: number | null; absent: number | null; onLeave: number | null; halfDayLeave: number | null; pendingApprovals: number | null };
  attention: MyTeamAttention[]; actionableApprovals: MyTeamApproval[];
};
export type MyTeamRosterScope = { companyIds: string[]; employmentIds: string[]; from: string; to: string; canEditRoster: boolean };
export type MyTeamPunchReviewResult = { reviewed: true; reviewId: string };
