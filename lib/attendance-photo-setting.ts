/** Canonical capture rule vocabulary shared by the owner and Personnel consumers. */
export const ATTENDANCE_PHOTO_SETTINGS=['required','optional','not_required'] as const;
export type AttendancePhotoSetting=(typeof ATTENDANCE_PHOTO_SETTINGS)[number];
export const ATTENDANCE_PHOTO_LABEL_KEYS={required:'people.detail.clocking.attendancePhotoRequired',optional:'people.detail.clocking.attendancePhotoOptional',not_required:'people.detail.clocking.attendancePhotoNotRequired'} as const;
