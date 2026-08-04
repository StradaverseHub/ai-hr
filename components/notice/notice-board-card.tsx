import Link from 'next/link';

import { Card, SectionHeader } from '@/components/ui';

export type NoticeCardItem = { id: string; title: string; unread: boolean };

/**
 * 6e122302 — the dashboard's Notice Board card.
 *
 * A plain SERVER component taking already-resolved, already-translated data: it is mounted into
 * `app/page.tsx`'s `cardNodes` map, which the client `DashboardCustomizer` renders, so anything
 * non-serialisable here would cross the boundary r124 broke production on.
 *
 * The card shows the newest few notices and the unread count the reporter asked for ("Notice Board
 * (3 New)"). UNREAD means never opened — `notice_recipient.first_viewed_at IS NULL` — which is a view
 * marker, not an acknowledgement.
 */
export function NoticeBoardCard({
  items,
  unread,
  title,
  emptyLabel,
  viewAllLabel,
  newCountLabel,
}: {
  items: NoticeCardItem[];
  unread: number;
  title: string;
  emptyLabel: string;
  viewAllLabel: string;
  /** Already interpolated, e.g. "3 new" — the count is resolved server-side with the rest of the copy. */
  newCountLabel: string;
}) {
  return (
    <Card>
      <SectionHeader title={unread > 0 ? `${title} · ${newCountLabel}` : title} />
      <ul className="divide-y divide-border">
        {items.length === 0 && (
          <li className="px-4 py-4 text-center text-xs text-muted-foreground">{emptyLabel}</li>
        )}
        {items.map((n) => (
          <li key={n.id} className="px-4 py-2.5">
            <Link href={`/notices/${n.id}`} className="flex items-center justify-between gap-2">
              <span className="min-w-0 truncate text-sm text-foreground">{n.title}</span>
              {n.unread && <span className="size-1.5 shrink-0 rounded-full bg-primary" aria-hidden />}
            </Link>
          </li>
        ))}
      </ul>
      <div className="border-t border-border px-4 py-2.5">
        <Link href="/notices" className="text-xs font-medium text-primary underline underline-offset-2">
          {viewAllLabel}
        </Link>
      </div>
    </Card>
  );
}
