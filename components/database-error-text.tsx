'use client';

import { useTranslations } from 'next-intl';
import { parseDatabaseErrorRef } from '@/lib/database-error-token';

/**
 * r388 — a redacted database error (lib/public-error.ts) in the viewer's language. The English sentence in
 * `?error=` carries a `DB-<kind>-<ref>` reference; this shows the same sentence from messages/*.json
 * (common.databaseError), keeping the reference so support can find the server log line.
 */
export function useDatabaseErrorText(): (message: string) => string {
  const t = useTranslations('common.databaseError');
  return (message: string) => {
    const parsed = parseDatabaseErrorRef(message);
    return parsed ? t(parsed.kind, { ref: parsed.ref }) : message;
  };
}

export function DatabaseErrorText({ message }: { message: string }) {
  return <>{useDatabaseErrorText()(message)}</>;
}
