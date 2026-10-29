/** M08 — one task and its confirmed decision (mobile/lib/approval-decision.tsx). */
import { useLocalSearchParams } from 'expo-router';
import { ApprovalDetailScreen } from '../../../lib/approval-decision';
export default function ApprovalDetailPage() {
  const { kind, id } = useLocalSearchParams<{ kind: string; id: string }>();
  return <ApprovalDetailScreen kind={typeof kind === 'string' ? kind : ''} id={typeof id === 'string' ? id : ''} />;
}
