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

/** Entitled days per leave type. 0 for unpaid / unknown. */
export function entitlement(code: string, serviceYears: number): number {
  switch (code) {
    case 'ANNUAL':
      return annualEntitlement(serviceYears);
    case 'SICK':
      return 14; // 14/yr (without hospitalization)
    case 'HOSPITALIZATION':
      return 60; // up to 60/yr where hospitalization is required
    case 'MATERNITY':
      return 98;
    case 'PATERNITY':
      return 7;
    default:
      return 0;
  }
}
