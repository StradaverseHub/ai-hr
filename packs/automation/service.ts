/** Shared HR automation boundary (workflows, routings, email templates): definitions, their store and the shared runner. Modules inject their step executors. */
export * from '../../core/automation-store';
export * from '../../core/automation-email';
export * from '../../core/automation-documents';
export * from '../../core/automation-builder';
export * from '../../core/automation-groups';
export * from '../../core/automation-email-test';
export * from '../../lib/automation/conditions';
export * from '../../lib/automation/catalogue';
export * from '../../lib/automation/catalogues';
export * from '../../lib/automation/routing';
export * from '../../lib/automation/workflow';
export * from '../../lib/automation/email';
// The shared workflow runner (lane D1): pure decisions and execution, plus the run store of migration 5748.
export * from '../../core/automation-runtime';
export * from '../../lib/automation/runtime';
