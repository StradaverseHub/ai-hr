import { redirect } from 'next/navigation';
import { requireAdmin } from '@/lib/authz';
import { scheduleGroupEditPath } from '../../schedule-panel';

// 88e94371 — Edit one Schedule Group. 6d091cc0 (r301): the form opened as a panel on Attendance › Schedule ›
// General. 665de026 (r331): the reporter contested that shape, so each group has a page of its own again and
// this address redirects to its Edit Schedule page. requireAdmin() first, for the reasons in ../new/page.tsx.
//
// `ruleId` is an UNTRUSTED URL SEGMENT and is not checked here: it never reaches a query from this file, and
// the page it lands on validates the uuid SHAPE before its own read and answers a junk or unknown id with the
// "not on this list" sentence rather than a 500 (the r263 verifier's crash, restated).
export default async function EditAttendanceRulePage({ params }: { params: Promise<{ ruleId: string }> }) {
  await requireAdmin();
  const { ruleId } = await params;
  redirect(scheduleGroupEditPath(ruleId));
}
