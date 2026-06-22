/**
 * Malaysia public holidays 2026.
 *
 * ⚠️ ILLUSTRATIVE — fixed-date holidays only. Islamic holidays (Aidilfitri, Aidiladha, Awal Muharram,
 * Maulidur Rasul), Thaipusam, and the various state ruler birthdays are intentionally OMITTED: their
 * dates shift year to year and must be verified against the official Federal/State gazette before
 * production use (compliance sourcing, per ADR-0007). The COMPLETE per-state calendar is loaded via the
 * admin Holidays screen — the state engine (ADR-0038 2C) is what this pack seeds an illustrative subset of.
 */

/** The 13 states + 3 Federal Territories. work_state / holiday.state use these exact labels. */
export const MY_STATES = [
  'Johor',
  'Kedah',
  'Kelantan',
  'Melaka',
  'Negeri Sembilan',
  'Pahang',
  'Perak',
  'Perlis',
  'Pulau Pinang',
  'Sabah',
  'Sarawak',
  'Selangor',
  'Terengganu',
  'Kuala Lumpur',
  'Labuan',
  'Putrajaya',
] as const;
export type MyState = (typeof MY_STATES)[number];

export type MyHoliday = { date: string; name: string; state?: MyState };

/** National (gazetted federal) holidays — apply in every state. Fixed-date subset only. */
export const MY_HOLIDAYS_2026: MyHoliday[] = [
  { date: '2026-01-01', name: "New Year's Day" },
  { date: '2026-02-17', name: 'Chinese New Year' },
  { date: '2026-02-18', name: 'Chinese New Year (2nd Day)' },
  { date: '2026-05-01', name: 'Labour Day' },
  { date: '2026-05-31', name: 'Wesak Day' },
  { date: '2026-06-01', name: "Yang di-Pertuan Agong's Birthday" },
  { date: '2026-08-31', name: 'National Day (Merdeka)' },
  { date: '2026-09-16', name: 'Malaysia Day' },
  { date: '2026-11-08', name: 'Deepavali' },
  { date: '2026-12-25', name: 'Christmas Day' },
];

/**
 * State-specific holidays — fixed-date, well-established subset only. Each applies ONLY to employees
 * working in that state. (Ruler birthdays + lunar/Islamic state holidays omitted pending the gazette.)
 *  - Federal Territory Day (1 Feb) — Kuala Lumpur, Labuan, Putrajaya.
 *  - Pesta Kaamatan / Harvest Festival (30–31 May) — Sabah, Labuan.
 *  - Gawai Dayak (1–2 Jun) — Sarawak.
 *  - Sarawak Day (22 Jul) — Sarawak.
 */
export const MY_STATE_HOLIDAYS_2026: MyHoliday[] = [
  { date: '2026-02-01', name: 'Federal Territory Day', state: 'Kuala Lumpur' },
  { date: '2026-02-01', name: 'Federal Territory Day', state: 'Labuan' },
  { date: '2026-02-01', name: 'Federal Territory Day', state: 'Putrajaya' },
  { date: '2026-05-30', name: 'Pesta Kaamatan', state: 'Sabah' },
  { date: '2026-05-31', name: 'Pesta Kaamatan', state: 'Sabah' },
  { date: '2026-05-30', name: 'Pesta Kaamatan', state: 'Labuan' },
  { date: '2026-05-31', name: 'Pesta Kaamatan', state: 'Labuan' },
  { date: '2026-06-01', name: 'Gawai Dayak', state: 'Sarawak' },
  { date: '2026-06-02', name: 'Gawai Dayak', state: 'Sarawak' },
  { date: '2026-07-22', name: 'Sarawak Day', state: 'Sarawak' },
];
