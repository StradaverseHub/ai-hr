'use client';

import { useTranslations } from 'next-intl';
import { parseDatabaseErrorRef } from '@/lib/database-error-token';

/**
 * r388 — a redacted database error (lib/public-error.ts) in the viewer's language. The English sentence in
 * `?error=` carries a `DB-<kind>[<reason>]-<ref>` reference; this shows the same sentence from
 * messages/*.json — the specific explanation (common.databaseErrorReason) when the reference names one,
 * otherwise the kind's (common.databaseError) — keeping the reference so support can find the log line.
 */
export function useDatabaseErrorText(): (message: string) => string {
  const t = useTranslations('common.databaseError');
  const tReason = useTranslations('common.databaseErrorReason');
  return (message: string) => {
    const parsed = parseDatabaseErrorRef(message);
    if (!parsed) return message;
    return parsed.reason ? tReason(parsed.reason, { ref: parsed.ref }) : t(parsed.kind, { ref: parsed.ref });
  };
}

export function DatabaseErrorText({ message }: { message: string }) {
  return <>{useDatabaseErrorText()(message)}</>;
}
