import { getTranslations } from 'next-intl/server';
import { requireAdmin } from '@/lib/authz';
import { AttendanceSettingsNavigation } from '@/components/attendance-settings-navigation';
import { PageHeader, pageWideCls } from '@/components/ui';
import { OfflineClockingCard } from '../../../attendance-policy/offline-clocking-card';
import { loadOfflineClockingSettings } from '../../../attendance-policy/offline-clocking-data';

export default async function OfflineClockingSettingsPage() {
  const session = await requireAdmin();
  const t = await getTranslations('attendanceSettingsHub');
  const companies = await loadOfflineClockingSettings(session);

  return (
    <div className={pageWideCls}>
      <AttendanceSettingsNavigation />
      <PageHeader title={t('offlineClocking.title')} back={{ href: '/admin/attendance/settings', label: t('backToSettings') }} />
      <OfflineClockingCard companies={companies} />
    </div>
  );
}
