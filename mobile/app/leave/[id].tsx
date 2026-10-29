/** M07 — one leave request with Withdraw / Cancel dates when offered (mobile/lib/leave-history.tsx). */
import { useLocalSearchParams } from 'expo-router';
import { LeaveDetailScreen } from '../../lib/leave-history';
export default function LeaveDetailPage() {
  const { id } = useLocalSearchParams<{ id: string }>();
  return <LeaveDetailScreen id={typeof id === 'string' ? id : ''} />;
}
