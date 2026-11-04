'use client';

import type {ReactNode} from 'react';
import {usePathname} from 'next/navigation';

/** The root loading boundary (app/loading.tsx) also stands in, on a first load, for any nested segment that has
 * not drawn its own boundary yet. So the Today skeleton is drawn only for Today itself (`/`); every other path
 * keeps the shared generic shell (components/route-loading.tsx). Both are server-rendered and passed in. */
export function RootLoadingSwitch({today,fallback}:{today:ReactNode;fallback:ReactNode}){
 return <>{(usePathname()??'/')==='/'?today:fallback}</>;
}
