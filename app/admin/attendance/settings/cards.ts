/**
 * r431 (bdfe4968) — the five attendance setup pages that used to be rows in the Attendance menu, now the
 * cards on /admin/attendance/settings. Plain data so test/r431-attendance-settings.test.ts can compare
 * these hrefs with the packs/attendance nav and the sidebar ownership without rendering the page.
 *
 * Every href is the page the row opened before; none of them moved. `key` names the
 * `attendanceSettingsHub.<key>` message group holding the card's title, description and button.
 */
export const ATTENDANCE_SETTINGS_CARDS = [
  { key: 'shift', href: '/admin/attendance' },
  { key: 'fileMapping', href: '/admin/attendance/file-mappings' },
  { key: 'schedule', href: '/admin/attendance/schedule' },
  { key: 'allowance', href: '/admin/attendance-allowance' },
  { key: 'locations', href: '/admin/work-locations/clocking' },
] as const;
