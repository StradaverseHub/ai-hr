/** M11 — one claim with Cancel / Edit, Submit or Delete when the kernel allows them (mobile/lib/claims.tsx). */
import { useLocalSearchParams } from 'expo-router';
import { ClaimDetailScreen } from '../../lib/claims';
export default function ClaimDetailPage() {
  const { id } = useLocalSearchParams<{ id: string }>();
  return <ClaimDetailScreen id={typeof id === 'string' ? id : ''} />;
}
