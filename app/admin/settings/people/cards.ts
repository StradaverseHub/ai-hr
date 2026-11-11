/**
 * 82748f92 — the cards on People › Settings (/admin/settings/people). The section list itself lives in
 * lib/navigation/people-settings.ts so the client shell (menu row ownership, command-bar aliases) and this page
 * read one list; this file is the page-local name for it, as app/admin/attendance/settings/cards.ts is.
 */
export { PEOPLE_SETTINGS_HREF, PEOPLE_SETTINGS_SECTIONS as PEOPLE_SETTINGS_CARDS, visiblePeopleSettingsSections } from '@/lib/navigation/people-settings';
