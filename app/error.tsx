'use client';

import {DegradedState} from '@/components/degraded-state';

export default function RootError({error, retry}: {error: Error & {digest?: string}; retry: () => void}) {
  return <DegradedState error={error} retry={retry} />;
}
