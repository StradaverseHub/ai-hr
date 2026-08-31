import { redirect } from 'next/navigation';

/**
 * The Control Tower moved OUT of the Payroll menu and became its own top-level section (r233): it is a
 * control plane for operational HR of which payroll is the first domain, not a payroll screen
 * (ADR-0083 §2.2). This forward is kept because the old path shipped in r229 and was live — a bookmark or
 * a link in someone's notes must not 404 to make a menu tidier.
 *
 * Permanent, not temporary: the destination is not coming back here.
 */
export default function MovedControlTower() {
  redirect('/control-tower');
}
