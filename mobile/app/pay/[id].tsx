/** M09 — one own payslip, viewed natively, and its confirmed, audited PDF share (mobile/lib/pay-documents.tsx). */
import { useLocalSearchParams } from 'expo-router';
import { PayslipDetailScreen } from '../../lib/pay-documents';
export default function PayslipDetailPage() {
  const { id } = useLocalSearchParams<{ id: string }>();
  return <PayslipDetailScreen id={typeof id === 'string' ? id : ''} />;
}
