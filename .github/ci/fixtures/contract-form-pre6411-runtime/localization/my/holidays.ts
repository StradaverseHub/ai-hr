/**
 * Malaysia public holidays 2026.
 *
 * NATIONAL (federal) gazette: FIXED-date holidays are certain. LUNAR / Islamic / moon-sighting holidays
 * (Chinese New Year, Aidilfitri, Aidiladha, Wesak, Awal Muharram, Maulidur Rasul, Deepavali) carry a
 * `verify: true` flag — they are sourced from published 2026 calendars and cross-checked against the
 * Islamic calendar, but are PROVISIONAL and can shift ±1 day. Confirm them against the Federal Government
 * P.U.(A) gazette + JAKIM moon-sighting before payroll go-live.
 *
 * PER-STATE holidays (ruler birthdays, Thaipusam, Nuzul Al-Quran, Good Friday in Sabah/Sarawak, state
 * Islamic days, etc.) vary across the 16 jurisdictions and are NOT loaded here — the customer's HR loads
 * their own states' gazette via the admin Holidays screen. The Phase-B #15 completeness guard
 * (core/holidays.ts) exists precisely to make that incompleteness LOUD: when a (state, year) has fewer than
 * the EA s.60D minimum of 11 gazetted holidays loaded, it warns on the leave/payroll screen.
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

/** A loaded public holiday. `verify: true` marks a lunar/Islamic/moon-sighting date that is PROVISIONAL —
 *  confirm against the Federal/State gazette + JAKIM before it drives payroll (it can shift ±1 day). */
export type MyHoliday = { date: string; name: string; state?: MyState; verify?: boolean };

/**
 * National (gazetted federal) holidays 2026 — apply in every state. Dates per the Phase-B #15 plan
 * (planPath); do not invent dates beyond it.
 *
 * FIXED (certain): New Year, Labour Day, Agong's Birthday (first Mon of June), National Day, Malaysia Day,
 * Christmas.
 *
 * LUNAR / moon-sighting (verify: true — PROVISIONAL, confirm against the Federal Government P.U.(A) gazette
 * + JAKIM moon-sighting before payroll go-live; they can shift ±1 day): Chinese New Year (+ Day 2), Hari
 * Raya Aidilfitri (incl. the declared additional day on 20 Mar + Day 2 on 22 Mar), Hari Raya Aidiladha
 * (Haji), Wesak, Awal Muharram, Maulidur Rasul, Deepavali.
 */
export const MY_HOLIDAYS_2026: MyHoliday[] = [
  // ── FIXED-date national holidays (certain) ──
  { date: '2026-01-01', name: "New Year's Day" },
  { date: '2026-05-01', name: 'Labour Day' },
  { date: '2026-06-01', name: "Yang di-Pertuan Agong's Birthday" }, // first Mon of June
  { date: '2026-08-31', name: 'National Day (Merdeka)' },
  { date: '2026-09-16', name: 'Malaysia Day' },
  { date: '2026-12-25', name: 'Christmas Day' },

  // ── LUNAR / Islamic / moon-sighting (verify: true — provisional, confirm against P.U. gazette + JAKIM) ──
  { date: '2026-02-17', name: 'Chinese New Year', verify: true },
  { date: '2026-02-18', name: 'Chinese New Year (2nd Day)', verify: true },
  { date: '2026-03-20', name: 'Hari Raya Aidilfitri (additional)', verify: true }, // declared additional day
  { date: '2026-03-21', name: 'Hari Raya Aidilfitri', verify: true },
  { date: '2026-03-22', name: 'Hari Raya Aidilfitri (2nd Day)', verify: true },
  { date: '2026-05-27', name: 'Hari Raya Aidiladha (Haji)', verify: true },
  { date: '2026-05-31', name: 'Wesak Day', verify: true },
  { date: '2026-06-17', name: 'Awal Muharram', verify: true },
  { date: '2026-08-25', name: 'Maulidur Rasul', verify: true },
  { date: '2026-11-08', name: 'Deepavali', verify: true },
];

/**
 * State-specific holidays 2026 — fixed-date, well-established subset only. Each applies ONLY to employees
 * working in that state.
 *
 * ⚠️ HR DATA-ENTRY NOTE: this is NOT the full per-state gazette. Ruler-birthday, Thaipusam, Nuzul Al-Quran,
 * Good Friday (Sabah/Sarawak), state Islamic days and other per-state/lunar holidays vary across the 16
 * jurisdictions and are NOT loaded here — the customer's HR must load their own states' gazette via the
 * admin Holidays screen. The Phase-B #15 completeness guard warns on the leave/payroll screen whenever a
 * (state, year) has fewer than the EA s.60D minimum of 11 gazetted holidays loaded, so this gap is loud.
 *
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
