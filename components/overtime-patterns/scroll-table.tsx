'use client';
import {useTranslations} from 'next-intl';
import type {ReactNode} from 'react';
/** A named focus target makes every column reachable by keyboard on narrow screens. */
export function OvertimeScrollTable({label,children}:{label:string;children:ReactNode}){
 const t=useTranslations('overtimePatterns');
 return <div className="space-y-2"><p className="text-xs text-muted-foreground sm:hidden">{t('guided.horizontalScroll')}</p><div role="region" aria-label={label} tabIndex={0} className="max-w-full overflow-x-auto overscroll-x-contain rounded-md focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary">{children}</div></div>;
}
