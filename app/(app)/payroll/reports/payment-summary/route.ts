/**
 * Batch payment summary CSV (manual bank upload). A neutral employee/bank/account/net-pay list —
 * NOT a byte-exact bank giro file (that's bank-specific Layer-B work). The export is logged as a
 * domain event on the batch. Admin-only; available once the batch is processed/closed.
 */
import { getSession } from '@/lib/session';
import { isAdmin } from '@/lib/authz';
import { paymentSummaryForBatch, PaymentSummaryNotReadyError } from '@/core/payroll';

export async function GET(req: Request) {
  const s = await getSession();
  if (!isAdmin(s)) return new Response('Forbidden', { status: 403 });
  const url = new URL(req.url);
  const batchId = url.searchParams.get('batchId') ?? '';
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!UUID.test(batchId)) return new Response('A valid batchId (uuid) is required', { status: 400 });
  try {
    const file = await paymentSummaryForBatch(s, batchId);
    return new Response(file.content, {
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="${file.filename}"`,
      },
    });
  } catch (e) {
    // Readiness reasons are safe and actionable; raw driver errors are not.
    if (e instanceof PaymentSummaryNotReadyError) return new Response(e.message, { status: 422 });
    console.error('payment-summary generation failed', e);
    return new Response('Could not generate the payment summary — please try again.', { status: 500 });
  }
}
