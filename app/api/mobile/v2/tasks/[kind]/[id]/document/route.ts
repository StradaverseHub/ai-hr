/**
 * GET /api/mobile/v2/tasks/leave/{id}/document — M08. The supporting document of a leave request the caller is
 * currently assigned (the detail's admission), through getLeaveAttachment. A protected binary
 * (mobileBinaryRoute: private, no-store, attachment, size bound, signature checked).
 *
 * WIDENED FOR THIS ROUTE ONLY: the leave attachment owner stores PDF, JPG and PNG (core/leave.ts DOC_MIME_LABELS),
 * and a medical certificate is very often a photo, so a PDF-only answer would send most approvers to the web.
 * JPEG and PNG are sent here with their own signatures checked (lib/mobile-api/binary-types.ts); every other binary
 * route stays PDF-only. A stored file of any other type, or whose bytes do not match its label, is
 * `unsupported_document`.
 */
import { taskDocumentV2 } from '@/core/mobile-approvals';
import { MOBILE_ATTACHMENT_TYPES, mobileBinaryRoute, MobileBadRequest } from '@/lib/mobile-api/handler';
import { taskOf } from '@/lib/mobile-api/task-routes';
import { TaskDocumentRefusal } from '@/lib/mobile-api/v2/tasks';

export const GET = mobileBinaryRoute(TaskDocumentRefusal, async (s, req) => {
  const { kind, id } = taskOf(req);
  if (kind !== 'leave') throw new MobileBadRequest('Only a leave request carries a document here');
  return taskDocumentV2(s, id);
}, { types: MOBILE_ATTACHMENT_TYPES });
