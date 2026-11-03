/** AI v2 Phase 1, W4 — the Ask Chats column's grouping (approved mock-up Ask.dc.html): Today, Yesterday, Earlier.
 *
 * Days are Kuala Lumpur calendar days through the repository's HR date owner (lib/hr-date.ts), and "today" is
 * passed in from the server's render so the browser and the server group the same way. The list order is the
 * owner's (core/teras-chats.ts: most recent message first); grouping never reorders it. Pure. */
import { todayInKualaLumpur } from '../hr-date';

export type ChatGroup = 'today' | 'yesterday' | 'earlier';
export const CHAT_GROUPS: readonly ChatGroup[] = ['today', 'yesterday', 'earlier'];

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

/** The calendar day before an ISO yyyy-mm-dd day. */
export function previousDay(day: string): string {
  const at = new Date(day + 'T00:00:00Z');
  at.setUTCDate(at.getUTCDate() - 1);
  return at.toISOString().slice(0, 10);
}

/** Which group a chat whose last message was at `lastMessageAt` falls in, on the Kuala Lumpur day `today`.
 * An unreadable time is "earlier", never "today". */
export function chatGroupOf(lastMessageAt: string, today: string): ChatGroup {
  const at = new Date(lastMessageAt);
  if (!ISO_DAY.test(today) || !Number.isFinite(at.getTime())) return 'earlier';
  const day = todayInKualaLumpur(at);
  if (day >= today) return 'today';
  return day === previousDay(today) ? 'yesterday' : 'earlier';
}

/** The non-empty groups, in Today, Yesterday, Earlier order, each keeping the list's own order. */
export function groupChats<T extends { lastMessageAt: string }>(chats: readonly T[], today: string): { group: ChatGroup; chats: T[] }[] {
  const buckets = new Map<ChatGroup, T[]>(CHAT_GROUPS.map(group => [group, []]));
  for (const chat of chats) buckets.get(chatGroupOf(chat.lastMessageAt, today))!.push(chat);
  return CHAT_GROUPS.map(group => ({ group, chats: buckets.get(group)! })).filter(entry => entry.chats.length > 0);
}

/** Case-insensitive search over the label the person sees; an empty query matches everything. */
export function matchesChatSearch(label: string, query: string): boolean {
  const q = query.trim().toLocaleLowerCase();
  return !q || label.toLocaleLowerCase().includes(q);
}
