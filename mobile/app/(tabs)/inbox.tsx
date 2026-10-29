/**
 * Inbox — M10: the caller's own notifications, paged (GET /api/mobile/v2/notifications), with unread state, Mark all
 * read and server-allowlisted destinations (mobile/lib/inbox.tsx). This is where a push will deep-link to: the push
 * itself carries no content (ADR-0088 §3). M10 (D6): the contextual "Turn on notifications" control sits under the counts — compact since the declutter round
 * (the one button, only while off); the full notification control and its explanation live on Me → This phone.
 */
import { InboxScreen } from '../../lib/inbox';
import { PushPrompt } from '../../lib/push';
export default function Inbox() { return <InboxScreen prompt={<PushPrompt compact />} />; }
