import { getLocale } from 'next-intl/server';
import { HR_LOCAL_TZ } from '@/lib/hr-date';

/** Render the recorded instant, including its time; never substitute the viewer's current date. */
export async function TestingRecordedTime({ value }: { value: Date }) {
  const locale = await getLocale();
  return <time dateTime={value.toISOString()} title={HR_LOCAL_TZ} className="tabular-nums">{new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'medium', timeZone: HR_LOCAL_TZ }).format(value)}</time>;
}
