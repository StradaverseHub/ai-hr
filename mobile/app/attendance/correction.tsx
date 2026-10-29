/** M12 (D13) — a missed-punch / correction request for one own day (mobile/lib/attendance-requests.tsx). */
import { useLocalSearchParams } from 'expo-router';
import { AttendanceCorrectionScreen } from '../../lib/attendance-requests';
export default function AttendanceCorrectionPage() {
  const { date } = useLocalSearchParams<{ date: string }>();
  return <AttendanceCorrectionScreen date={typeof date === 'string' ? date : ''} />;
}
