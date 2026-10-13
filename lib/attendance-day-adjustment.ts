/** Stored date corrections. No dependency on the engine or database schema. */
export type AttendanceDayKindOverride = 'workday' | 'off_day' | 'rest_day' | 'holiday';
export type AttendanceOtBucket = 'flat' | 'ot00' | 'ot10' | 'ot15' | 'ot20' | 'ot30';
export type ManualOtRow = {
  minutes:number;bucket:AttendanceOtBucket;calculatedMinutes:number;recordedAt:string;actorId:string;
};
export type ManualOtRows = Record<string,ManualOtRow>;
export type AttendanceAdminAmendment = {
  version:string;checkIn:string|null;checkOut:string|null;reason:string;actorId:string;recordedAt:string;
};
