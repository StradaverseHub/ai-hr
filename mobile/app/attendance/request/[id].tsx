/** M12 (D13) — one own attendance application, with Withdraw when offered (mobile/lib/attendance-applications.tsx). */
import { useLocalSearchParams } from 'expo-router';
import { AttendanceApplicationScreen } from '../../../lib/attendance-applications';
export default function AttendanceApplicationPage() {
  const { id } = useLocalSearchParams<{ id: string }>();
  return <AttendanceApplicationScreen id={typeof id === 'string' ? id : ''} />;
}
