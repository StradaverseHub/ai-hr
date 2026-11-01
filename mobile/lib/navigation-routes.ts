/** Keep the parent destination selected on pushed routes without changing their Back history. */
export function dailyDestinationForPath(path: string): '/' | '/clock' | '/leave' | '/work' | '/me' | null {
  const section = path.split('/')[1];
  if (!section || section === 'inbox') return '/';
  if (section === 'clock' || section === 'attendance') return '/clock';
  if (section === 'leave') return '/leave';
  if (section === 'approvals' || section === 'work') return '/work';
  if (['me', 'profile', 'pay', 'settings', 'notifications', 'integrity-keys', 'pending-submissions', 'company', 'directory', 'team', 'team-calendar'].includes(section)) return '/me';
  return null;
}
