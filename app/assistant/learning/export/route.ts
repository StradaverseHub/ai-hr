/**
 * AI v2 Phase 2, P2-6 — an exported eval candidate as a file: GET ?candidate=<id> -> one .ts snippet for a developer to add
 * to test/assistant-smart-eval-set.ts (core/learning/export.ts).
 *
 * WHO. An HR or group administrator of the candidate's company (core/learning/review.ts candidateExportFile and the 0972
 * policies). Only a candidate an administrator approved and then exported (the server action exportCandidateAction, which a
 * link cannot trigger) is served; anything else, a malformed request and a candidate outside the caller's reach all get the
 * same bare 404. Read-only: it changes no state. The file holds the approved redacted text with fictional values in place
 * of every placeholder, and no tenant, company, person or record id.
 */
import { getSession } from '@/lib/session';
import { LearningRefused } from '@/core/learning/access';
import { candidateExportFile } from '@/core/learning/review';

export const runtime = 'nodejs';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const notFound = () => new Response('Not found', { status: 404, headers: { 'Cache-Control': 'private, no-store' } });

export async function GET(req: Request) {
  const candidate = new URL(req.url).searchParams.get('candidate');
  if (!candidate || !UUID.test(candidate)) return notFound();
  const s = await getSession();
  if (!s?.userId || s.agent) return notFound();
  try {
    const file = await candidateExportFile(s, { candidateId: candidate });
    return new Response(file.text, {
      headers: {
        'Content-Type': 'text/plain; charset=utf-8',
        'Content-Disposition': `attachment; filename="${file.fileName}"`,
        'Cache-Control': 'private, no-store',
        'X-Content-Type-Options': 'nosniff',
      },
    });
  } catch (e) {
    if (e instanceof LearningRefused) return notFound();
    throw e;
  }
}
