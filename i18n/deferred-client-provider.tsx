'use client';

import dynamic from 'next/dynamic';

/** The root also serves sign-in. Load the full catalog only when a shell actually renders this provider. */
export const CatalogClientProvider = dynamic(
  () => import('./client-provider').then(module => module.CatalogClientProvider),
);
