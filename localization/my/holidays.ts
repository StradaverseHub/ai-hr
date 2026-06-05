/**
 * Malaysia federal public holidays 2026.
 *
 * ⚠️ ILLUSTRATIVE — fixed-date holidays only. Islamic holidays (Aidilfitri, Aidiladha,
 * Awal Muharram, Maulidur Rasul) and any state holidays are intentionally OMITTED here:
 * their dates must be verified against the official Federal Government gazette before
 * production use (compliance sourcing, per ADR-0007).
 */
export const MY_HOLIDAYS_2026: { date: string; name: string }[] = [
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
