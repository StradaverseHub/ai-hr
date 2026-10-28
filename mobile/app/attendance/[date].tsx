/** M12 (D13) — one own attendance day in full, its applications and the correction entry (mobile/lib/attendance-records.tsx). */
import { useLocalSearchParams } from 'expo-router';
import { AttendanceDayScreen } from '../../lib/attendance-records';
export default function AttendanceDayPage() {
  const { date } = useLocalSearchParams<{ date: string }>();
  return <AttendanceDayScreen date={typeof date === 'string' ? date : ''} />;
}
