'use client';
import type {ReactNode} from 'react';
/** Changes submit the same validated GET criteria used by deep links and back navigation. */
export function ReconciliationFilters({children}:{children:ReactNode}){
 return <form method="get" className="grid gap-4 sm:grid-cols-3" onChange={event=>event.currentTarget.requestSubmit()}>{children}</form>;
}
