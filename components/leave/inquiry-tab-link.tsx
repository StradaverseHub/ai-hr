'use client';

import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import type { ComponentProps } from 'react';

import { INQUIRY_PICKER_KEYS } from '@/lib/inquiry-picker-context';

/** Picker controls own their state; the URL is their bookmarkable navigation projection. */
export function InquiryTabLink(props: ComponentProps<typeof Link> & { href: string }) {
  const current = useSearchParams();
  const [path, query = ''] = props.href.split('?');
  const next = new URLSearchParams(query);
  for (const key of INQUIRY_PICKER_KEYS) {
    next.delete(key);
    const value = current.get(key);
    if (value) next.set(key, value);
  }
  const suffix = next.toString();
  return <Link {...props} href={suffix ? `${path}?${suffix}` : path} />;
}
