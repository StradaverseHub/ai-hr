/** Malaysia leave rules (Employment Act 1955). Part of the MY localization pack (ADR-0008). */
import type { LeaveEligibility } from '../../core/leave';

export type MyLeaveTypeDef = {
  code: string;
  name: string;
  paid: boolean;
  counting: 'working_days' | 'calendar_days';
  eligibility?: LeaveEligibility; // ADR-0038 2A-1 — lawful gate (only where the Act restricts)
  requiresDocument?: boolean; // ADR-0038 2A-2 — supporting document needed (e.g. MC)
  sendToPayroll?: boolean; // Unpaid-leave payroll-impact: emit the on-approval payroll signal. Defaults to !paid in seed.
  i18n?: Record<string, { name: string }>; // ADR-0038 2F-2 / R37 — per-locale display names
};

export const MY_LEAVE_TYPES: MyLeaveTypeDef[] = [
  {
    code: 'ANNUAL',
    name: 'Annual Leave',
    paid: true,
    counting: 'working_days',
    i18n: { ms: { name: 'Cuti Tahunan' }, zh: { name: '年假' }, ta: { name: 'ஆண்டு விடுப்பு' }, th: { name: 'การลาพักร้อน' }, vi: { name: 'Nghỉ phép năm' } },
  },
  // Paid sick & hospitalization leave is conditioned on certification by a registered medical
  // practitioner / dental surgeon (EA-1955 s.60F(1)), so both require a supporting document.
  {
    code: 'SICK',
    name: 'Sick Leave',
    paid: true,
    counting: 'calendar_days',
    requiresDocument: true,
    i18n: { ms: { name: 'Cuti Sakit' }, zh: { name: '病假' }, ta: { name: 'நோய் விடுப்பு' }, th: { name: 'การลาป่วย' }, vi: { name: 'Nghỉ ốm' } },
  },
  {
    code: 'HOSPITALIZATION',
    name: 'Hospitalization Leave',
    paid: true,
    counting: 'calendar_days',
    requiresDocument: true,
    i18n: { ms: { name: 'Cuti Kemasukan Hospital' }, zh: { name: '住院假' }, ta: { name: 'மருத்துவமனை விடுப்பு' }, th: { name: 'การลานอนโรงพยาบาล' }, vi: { name: 'Nghỉ nằm viện' } },
  },
  // Maternity — female employee (EA-1955 s.37, as amended by Act A1651 2022; 98 days).
  {
    code: 'MATERNITY',
    name: 'Maternity Leave',
    paid: true,
    counting: 'calendar_days',
    eligibility: { gender: 'female' },
    i18n: { ms: { name: 'Cuti Bersalin' }, zh: { name: '产假' }, ta: { name: 'மகப்பேறு விடுப்பு' }, th: { name: 'การลาคลอด' }, vi: { name: 'Nghỉ thai sản' } },
  },
  // Paternity — married male employee, ≥12 months service (EA-1955 s.60FA, inserted by Act A1651 2022; 7 days).
  {
    code: 'PATERNITY',
    name: 'Paternity Leave',
    paid: true,
    counting: 'calendar_days',
    eligibility: { gender: 'male', maritalStatus: 'married', minServiceMonths: 12 },
    i18n: { ms: { name: 'Cuti Paterniti' }, zh: { name: '陪产假' }, ta: { name: 'தந்தைமை விடுப்பு' }, th: { name: 'การลาเพื่อดูแลบุตร' }, vi: { name: 'Nghỉ chăm vợ sinh' } },
  },
  {
    code: 'UNPAID',
    name: 'Unpaid Leave',
    paid: false,
    counting: 'calendar_days',
    sendToPayroll: true, // unpaid → emit the on-approval payroll signal by default (matches the migration backfill)
    i18n: { ms: { name: 'Cuti Tanpa Gaji' }, zh: { name: '无薪假' }, ta: { name: 'ஊதியமில்லா விடுப்பு' }, th: { name: 'การลาโดยไม่รับค่าจ้าง' }, vi: { name: 'Nghỉ không lương' } },
  },
  // Emergency Leave — an APPLICATION TYPE ONLY (no balance, no ledger, no policy/accrual). It is never in
  // STANDING_LEAVE_CODES and no leave_request row of type EMERGENCY is ever persisted: on submission
  // requestLeave decomposes it into ANNUAL (covered portion) + UNPAID (remainder) child requests. The
  // `paid`/`counting` fields here are INERT (no EL row is ever created) — the row exists only so the type
  // appears in the application dropdown and pickName can localize its display name. It carries no
  // eligibility, no durations, no policy.
  {
    code: 'EMERGENCY',
    name: 'Emergency Leave',
    paid: true,
    counting: 'calendar_days',
    i18n: { ms: { name: 'Cuti Kecemasan' }, zh: { name: '紧急假' }, ta: { name: 'அவசர விடுப்பு' }, th: { name: 'การลาฉุกเฉิน' }, vi: { name: 'Nghỉ khẩn cấp' } },
  },
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
