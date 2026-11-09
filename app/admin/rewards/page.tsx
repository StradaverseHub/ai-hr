import { redirect } from 'next/navigation';

export default async function LegacyRewardsConfiguration({ searchParams }: {
  searchParams: Promise<{ version?: string; year?: string; error?: string; sharedError?: string }>;
}) {
  const { version, year, error, sharedError } = await searchParams;
  const query = new URLSearchParams();
  if (typeof version === 'string') query.set('version', version);
  if (typeof year === 'string') query.set('year', year);
  const message = error ?? sharedError;
  if (typeof message === 'string') query.set('error', message);
  redirect('/admin/rewards/plans' + (query.size ? '?' + query.toString() : ''));
}
