import Link from 'next/link';
import { getTranslations } from 'next-intl/server';

/** 96a54ed2 — shown above the unchanged My Attendance request screens when they are opened for a chosen employee. */
export async function OnBehalfBanner({ name, employeeCode }: { name: string; employeeCode: string | null }) {
  const t = await getTranslations('attendanceOnBehalf');
  return (
    <div role="status" data-on-behalf-banner className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-primary/40 bg-accent p-3 text-sm text-accent-foreground">
      <p className="font-medium">{t('banner', { name: [name, employeeCode].filter(Boolean).join(' · ') })}</p>
      <Link href="/attendance/on-behalf/request" className="inline-flex min-h-11 items-center text-primary underline">{t('changeEmployee')}</Link>
    </div>
  );
}
