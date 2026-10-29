/** M11 — the claim form: a new claim, or (`?draft=`) one of the caller's own drafts (mobile/lib/claim-form.tsx). */
import { useLocalSearchParams } from 'expo-router';
import { ClaimFormScreen } from '../../lib/claim-form';
export default function NewClaimPage() {
  const { draft } = useLocalSearchParams<{ draft?: string }>();
  return <ClaimFormScreen draftId={typeof draft === 'string' && draft ? draft : undefined} />;
}
