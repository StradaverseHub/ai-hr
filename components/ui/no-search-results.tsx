'use client';

import {useTranslations} from 'next-intl';

/** Shared default copy, with an optional screen-specific explanation. */
export function NoSearchResults({message}:{message?:string}) {
  const t=useTranslations('common');
  return <p role="status" className="px-2 py-3 text-center text-xs text-muted-foreground">{message??t('noSearchResults')}</p>;
}
