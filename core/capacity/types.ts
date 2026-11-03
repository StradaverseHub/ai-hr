/** AI v2 Phase 2, P2-4 — the HR capacity ledger's value shapes. A leaf: no imports, so db/teras-capacity-schema.ts can
 * type its JSON column from here without a cycle.
 *
 * An item is one kind of work AI Centre does that a person in HR would otherwise do by hand: a loop's completed card,
 * an employee question AI Centre answered, an AI-prepared action a person confirmed. Every figure is a count, a number
 * of minutes or a calendar date. Nothing here is a ratio of staff to employees (owner rule): the ledger reports time. */
export const CAPACITY_ITEMS=Object.freeze(['loop_payroll_inputs','loop_missed_clock_outs','loop_missing_employee_data','loop_probation_ending',
 'loop_document_expiry','questions_answered','actions_confirmed'] as const);
export type CapacityItem=(typeof CAPACITY_ITEMS)[number];
export const isCapacityItem=(value:unknown):value is CapacityItem=>typeof value==='string'&&(CAPACITY_ITEMS as readonly string[]).includes(value);

/** The process-assessment processes (core/process-assessment.ts ProcessId) whose event log measures an item's manual
 * handling: a missed clock-out was handled by hand as an attendance correction, missing employee data as a profile
 * change. Every other item has no event-log equivalent and takes the administrator's own minutes. */
export type MeasuredProcess='attendance_correction'|'profile_change';
export const MEASURED_BY:Readonly<Partial<Record<CapacityItem,MeasuredProcess>>>=Object.freeze({
 loop_missed_clock_outs:'attendance_correction',loop_missing_employee_data:'profile_change'});

/** event_log: minutes = the period's staff actions per case x the administrator's minutes per staff action;
 * entered: the administrator's own minutes per item. */
export type CapacityBasis='event_log'|'entered';
export type CapacityBaselineItem=Readonly<{minutes:number;basis:CapacityBasis;process?:MeasuredProcess;cases?:number;completed?:number;staffActions?:number}>;
export type CapacityBaselineItems=Readonly<Partial<Record<CapacityItem,CapacityBaselineItem>>>;

export const CAPACITY_PERIODS=Object.freeze(['last30','quarter','year'] as const);
export type CapacityPeriod=(typeof CAPACITY_PERIODS)[number];
export const isCapacityPeriod=(value:unknown):value is CapacityPeriod=>typeof value==='string'&&(CAPACITY_PERIODS as readonly string[]).includes(value);

/** Baseline period lengths an administrator may choose (days before Autopilot started). */
export const BASELINE_DAYS=Object.freeze([30,90,180] as const);
export type BaselineDays=(typeof BASELINE_DAYS)[number];
