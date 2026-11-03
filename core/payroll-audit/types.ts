/** AI v2 P2-2b — the Audit loop's closed vocabularies. A leaf: no imports, so db/payroll-audit-schema.ts can type its columns
 * from here. Every list mirrors a CHECK in migration 0965; test/payroll-audit-loop.test.ts pins the two together. */

/** The registry id of the Audit loop's switch (teras_worker_control, off by default). */
export const AUDIT_LOOP_ID='loop_payroll_audit' as const;
export const AUDIT_LOOP_VERSION='loop_payroll_audit@v1';

/** What one capture row is evidence of. */
export const AUDIT_CAPTURE_KINDS=Object.freeze(['run','inputs_snapshot','payslip','change','adjustment','rule_version','exception','approval',
 'bank_file','statutory_file','filing','payslip_release','correction','access','config_change','control_finding'] as const);
export type AuditCaptureKind=(typeof AUDIT_CAPTURE_KINDS)[number];

/** The continuous control checks. Each creates a finding with evidence for a person; none acts. */
export const AUDIT_CONTROL_IDS=Object.freeze(['bank_change_before_pay_day','shared_bank_account','pay_after_last_day','pay_without_attendance',
 'preparer_closed_run','adjustment_without_reason','formula_changed_open_period'] as const);
export type AuditControlId=(typeof AUDIT_CONTROL_IDS)[number];
export const isAuditControlId=(value:unknown):value is AuditControlId=>typeof value==='string'&&(AUDIT_CONTROL_IDS as readonly string[]).includes(value);

/** A person's disposition of a finding. The latest one is the finding's state; with none the finding is open. */
export const AUDIT_DISPOSITIONS=Object.freeze(['expected','corrected','false_positive','escalated'] as const);
export type AuditDisposition=(typeof AUDIT_DISPOSITIONS)[number];
export const isAuditDisposition=(value:unknown):value is AuditDisposition=>typeof value==='string'&&(AUDIT_DISPOSITIONS as readonly string[]).includes(value);

/** The fixed list of root causes for a post-run correction (a closed run reopened, or a processed run reset). */
export const AUDIT_ROOT_CAUSES=Object.freeze(['late_input','input_error','employee_data','configuration','rule_or_formula','missed_exception',
 'statutory_change','other'] as const);
export type AuditRootCause=(typeof AUDIT_ROOT_CAUSES)[number];
export const isAuditRootCause=(value:unknown):value is AuditRootCause=>typeof value==='string'&&(AUDIT_ROOT_CAUSES as readonly string[]).includes(value);

/** The four statutory files the loop follows to their due date, and the report or file types that prepare each. */
export const AUDIT_STATUTORY_FORMS=Object.freeze(['epf','socso_eis','pcb_cp39','hrd'] as const);
export type AuditStatutoryForm=(typeof AUDIT_STATUTORY_FORMS)[number];
export const STATUTORY_FORM_TYPES:Readonly<Record<AuditStatutoryForm,readonly string[]>>=Object.freeze({
 epf:Object.freeze(['my.epf','my.borang-a','my.epf.borang-a','my.ocbc.kwsp']),
 socso_eis:Object.freeze(['my.socso-eis','my.socso-eis-file','my.socso.perkeso-assist','my.ocbc.socso','my.borang-8a']),
 pcb_cp39:Object.freeze(['my.cp39','my.cp39-file','my.lhdn.cp39-edata','my.ocbc.lhdn']),
 hrd:Object.freeze(['my.hrd-levy']),
});
export const statutoryFormOf=(type:string):AuditStatutoryForm|null=>
 (AUDIT_STATUTORY_FORMS.find(form=>STATUTORY_FORM_TYPES[form].includes(type))??null);
/** EPF, SOCSO and EIS contributions, PCB (CP39) and the HRD Corp levy are each due by the 15th of the month after the pay
 * month. One constant, so the screen, the status and the pack say the same date. */
export const STATUTORY_DUE_DAY=15;

/** Where payroll data was viewed or exported. Each is one access log entry (a domain event, through db/events.ts). */
export const PAYROLL_ACCESS_SURFACES=Object.freeze(['register','payslip_admin','run_export','payslip_pdf','transaction_export',
 'payment_summary','bank_file','statutory_file','statutory_export','audit_view','audit_pack'] as const);
export type PayrollAccessSurface=(typeof PAYROLL_ACCESS_SURFACES)[number];
export const PAYROLL_ACCESS_EVENT='payroll-data.accessed';
export const PAYSLIP_OPENED_EVENT='payslip.opened';

/** The defaults a company keeps until a payroll administrator changes them (payroll_audit_control_setting). */
export const AUDIT_CONTROL_DEFAULTS=Object.freeze({bankChangeDays:7,adjustmentThreshold:1000});

/** The pay month as YYYY-MM. */
export const isPayPeriod=(value:unknown):value is string=>typeof value==='string'&&/^\d{4}-(0[1-9]|1[0-2])$/.test(value);
