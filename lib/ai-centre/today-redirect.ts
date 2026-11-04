import { TODAY_HREF } from './inbox-origin';

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** AI v2 Phase 1 retired the AI Centre Inbox; `/assistant?view=inbox` moves to Today at `/`. Only an approver's
 * request to open a leave recommendation travels along, and only as a well-formed id (Today checks again that it
 * is a leave request in the viewer's own queue before reading anything). Every other parameter is dropped. */
export function todayInboxRedirect(recommend: unknown): string {
  return typeof recommend === 'string' && GUID.test(recommend) ? `${TODAY_HREF}?recommend=${recommend.toLowerCase()}` : TODAY_HREF;
}
