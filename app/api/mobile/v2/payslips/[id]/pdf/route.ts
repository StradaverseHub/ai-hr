/**
 * GET /api/mobile/v2/payslips/{id}/pdf — M09. The PDF of one of the caller's own released payslips: the web route's
 * own file (app/(app)/me/payslip/pdf-file.ts), byte for byte. A protected binary (mobileBinaryRoute: private, no-store,
 * attachment, PDF signature checked, 30 per hour). The app asks for it only after the server has acknowledged the
 * person's confirmation to share it (POST …/documents/share-events), and deletes its temporary copy afterwards.
 */
import { mobileBinaryRoute } from '@/lib/mobile-api/handler';
import { payslipIdOf, payslipPdfV2 } from '@/lib/mobile-api/pay-routes';
import { DocumentRefusal } from '@/lib/mobile-api/v2/pay';

export const GET = mobileBinaryRoute(DocumentRefusal, async (s, req) => payslipPdfV2(s, payslipIdOf(req)));
