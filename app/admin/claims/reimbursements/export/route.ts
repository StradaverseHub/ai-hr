/**
 * Reimbursements bank-upload CSV — approved NON-taxable claims awaiting an off-cycle payout.
 * A neutral employee/bank/account/amount list, NOT a byte-exact giro file (bank-specific Layer-B
 * work). Read-only: downloading does not mark anything paid (that's an explicit action on the page).
 */
import { getSession } from '@/lib/session';
import { isAdmin } from '@/lib/authz';
import { reimbursementCsv } from '@/core/claims';

export async function GET() {
  const s = await getSession();
  if (!isAdmin(s)) return new Response('Forbidden', { status: 403 });
  try {
    const file = await reimbursementCsv(s);
    return new Response(file.content, {
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="${file.filename}"`,
      },
    });
  } catch (e) {
    console.error('reimbursement CSV generation failed', e);
    return new Response('Could not generate the reimbursement file — please try again.', { status: 500 });
  }
}
