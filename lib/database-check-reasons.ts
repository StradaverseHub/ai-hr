/**
 * 03877e — WHICH CHECK RULES HAVE A SPECIFIC EXPLANATION.
 *
 * Postgres names the CHECK constraint that refused a write (`constraint_name`), and that name is ours, so
 * lib/public-error.ts can say what was actually wrong instead of "one of the values is not allowed". The
 * entries were reviewed against each constraint's definition in db/migrations (2026-11-05); a rule not
 * listed here — most are internal invariants a user cannot act on — keeps the plain invalid-value sentence.
 * test/r388-public-error.test.ts keeps every name here pointing at a constraint that exists.
 *
 * Pure data: imported by server code only through lib/public-error.ts.
 */
import type { DatabaseErrorReason } from './database-error-token';

/** End before start: `valid_to >= valid_from`, `end_on >= start_on` and their kin. */
const DATE_ORDER = [
  'employment_shift_arrangement_range_ck',
  'entitlement_eligibility_rule_window_check',
  'entitlement_template_window_check',
  'notice_window_check',
  'performance_calibration_group_member_dates',
  'performance_hod_assignment_dates',
  'performance_leader_seat_dates',
  'reward_member_window',
  'tenant_suspension_window_order_check',
  'travel_request_range_ck',
];

/** A field that must be filled: blank text, or a value a switched-on option needs. */
const REQUIRED = [
  'clocking_file_mapping_name_ck',
  'employment_geofence_radius_required',
  'entitlement_eligibility_rule_name_check',
  'entitlement_template_name_check',
  'feedback_block_answer_not_blank_ck',
  'feedback_block_question_not_blank_ck',
  'leave_adjustment_batch_reason_check',
  'notice_body_check',
  'notice_title_check',
  'shift_daily_cutoff_time_required',
  'shift_fixed_anchors_required',
  'shift_flexible_break_minutes_required',
  'shift_full_flexi_duration_required',
];

/** A number outside its allowed range: negative amounts, minutes beyond a day, a month outside 1–12. */
const NUMBER_RANGE = [
  'attendance_allowance_policy_amount_nonneg',
  'attendance_overtime_policy_part_count_ck',
  'attendance_policy_geofence_accuracy_positive',
  'attendance_policy_offline_window_ck',
  'clocking_location_lat_range',
  'clocking_location_lng_range',
  'clocking_location_radius_m_ck',
  'company_probation_months_check',
  'employee_tp3_deduction_month_ck',
  'it_asset_request_qty_ck',
  'leave_generation_run_year_check',
  'leave_shared_group_max_days_check',
  'leave_shared_group_total_limit_check',
  'leave_type_accrual_day_check',
  'leave_type_carry_forward_expiry_months_check',
  'leave_type_carry_forward_max_check',
  'leave_type_carry_forward_percent_check',
  'leave_type_expiry_value_pos_ck',
  'leave_type_max_balance_days_check',
  'leave_type_max_consecutive_days_check',
  'leave_type_max_days_per_leave_year_check',
  'leave_type_max_negative_balance_check',
  'leave_type_rounding_threshold_check',
  'scheme_leave_combined_limit_max_days_check',
  'shift_early_leave_grace_nonneg',
  'shift_flexible_break_minutes_range',
  'shift_full_day_leave_minutes_ck',
  'shift_full_day_ot_minutes_ck',
  'shift_late_grace_nonneg',
  'shift_normal_hours_rounding_minutes_ck',
  'shift_ot_window_adjust_after_ck',
  'shift_ot_window_max_ck',
  'shift_ot_window_min_ck',
];

/** Text longer than its column allows. (Rules that also refuse an EMPTY value are left out: the sentence
 *  would be wrong for half of their refusals.) */
const TEXT_LENGTH = ['clocking_import_line_raw_ck', 'pay_component_description_length'];

export const CHECK_CONSTRAINT_REASONS: Readonly<Record<string, DatabaseErrorReason>> = Object.freeze({
  ...Object.fromEntries(DATE_ORDER.map((n) => [n, 'dateOrder'])),
  ...Object.fromEntries(REQUIRED.map((n) => [n, 'required'])),
  ...Object.fromEntries(NUMBER_RANGE.map((n) => [n, 'numberOutOfRange'])),
  ...Object.fromEntries(TEXT_LENGTH.map((n) => [n, 'textTooLong'])),
});

/**
 * A pick-list rule — `status IN ('draft','active')` — named by our convention `<table>_<attribute>_check`.
 * Reaching one means the form offered an option the database no longer accepts (a stale page or a retired
 * catalogue entry), so the advice is the same for all of them: reload and choose again.
 */
export const CHOICE_CONSTRAINT =
  /_(status|kind|type|category|mode|role|tier|levels?|outcome|severity|source|platform|unit|method|placement|scope|action|stage|direction|destination|disposition|resolution|encoding|layer|origin|frequency)(_check|_ck|_chk)$/;
