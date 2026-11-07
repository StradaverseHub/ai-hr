'use client';

import {useTranslations} from 'next-intl';

/** Shared default copy, with an optional screen-specific explanation. */
export function NoSearchResults({message}:{message?:string}) {
  // Callers that already supply translated copy do not need another translation context.
  return <p role="status" className="px-2 py-3 text-center text-xs text-muted-foreground">{message??<DefaultNoSearchResults/>}</p>;
}

function DefaultNoSearchResults() {
  const t=useTranslations('common');
  return t('noSearchResults');
}
