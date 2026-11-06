import { redirect } from 'next/navigation';

/** Reconciliation templates and results use the existing saved payroll report owner. */
export default function PayrollReconciliationPage() {
  redirect('/reports?cat=payroll');
}
