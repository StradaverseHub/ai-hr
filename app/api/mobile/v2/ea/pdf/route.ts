/**
 * GET /api/mobile/v2/ea/pdf?employmentId&year&company&lang — M09. The caller's own EA form (C.P.8A) as the web route
 * renders it (app/(app)/me/ea/document.ts), byte for byte, through mobileBinaryRoute. Foreign, unavailable or unreleased:
 * `not_found`; a form that cannot be laid out: `layout_unavailable` (no partial PDF).
 */
import { mobileBinaryRoute } from '@/lib/mobile-api/handler';
import { eaPdfV2 } from '@/lib/mobile-api/pay-routes';
import { EaDocumentRefusal } from '@/lib/mobile-api/v2/pay';

export const GET = mobileBinaryRoute(EaDocumentRefusal, async (s, req) => eaPdfV2(s, req));
