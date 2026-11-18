/** Lightweight payroll history barrier for country export snapshots. Avoid importing the broad payroll
 * facade here: its calculators resolve country packs, which would introduce a registry import cycle. */
export {withPayrollHistoryTenant} from '../../core/payroll-history-lock';
