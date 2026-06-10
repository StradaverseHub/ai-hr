/** Malaysia leave rules (Employment Act 1955). Part of the MY localization pack (ADR-0008). */

export type MyLeaveTypeDef = {
  code: string;
  name: string;
  paid: boolean;
  counting: 'working_days' | 'calendar_days';
};

export const MY_LEAVE_TYPES: MyLeaveTypeDef[] = [
  { code: 'ANNUAL', name: 'Annual Leave', paid: true, counting: 'working_days' },
  { code: 'SICK', name: 'Sick Leave', paid: true, counting: 'calendar_days' },
  { code: 'HOSPITALIZATION', name: 'Hospitalization Leave', paid: true, counting: 'calendar_days' },
  { code: 'MATERNITY', name: 'Maternity Leave', paid: true, counting: 'calendar_days' },
  { code: 'PATERNITY', name: 'Paternity Leave', paid: true, counting: 'calendar_days' },
  { code: 'UNPAID', name: 'Unpaid Leave', paid: false, counting: 'calendar_days' },
];

/** Annual leave entitlement by completed years of service (EA 1955 s.60E). */
export function annualEntitlement(serviceYears: number): number {
  if (serviceYears < 2) return 8;
  if (serviceYears <= 5) return 12; // 2–5 years
  return 16; // more than 5 years
}

/** Sick leave (outpatient) by completed years of service — EA 1955 s.60F(1)(aa)–(cc). */
export function sickEntitlement(serviceYears: number): number {
  if (serviceYears < 2) return 14;
  if (serviceYears < 5) return 18; // 2 – <5 years
  return 22; // 5+ years
}

/** Entitled days per leave type. 0 for unpaid / unknown.
 *
 *  Sources (verified 2026-06-10, see STATUTORY-SOURCES.md §5):
 *  - s.60F sick bands 14/18/22 per calendar year by service length.
 *  - Hospitalization: 60 days per calendar year, SEPARATE from outpatient sick —
 *    the Employment (Amendment) Act 2022 (in force 1 Jan 2023) deleted the proviso
 *    that previously capped both at 60 in aggregate.
 *  - Sick/hospitalization are per-calendar-year entitlements and are NOT prorated
 *    for mid-year joiners (unlike annual-leave practice).
 */
export function entitlement(code: string, serviceYears: number): number {
  switch (code) {
    case 'ANNUAL':
      return annualEntitlement(serviceYears);
    case 'SICK':
      return sickEntitlement(serviceYears);
    case 'HOSPITALIZATION':
      return 60;
    case 'MATERNITY':
      return 98;
    case 'PATERNITY':
      return 7;
    default:
      return 0;
  }
}
