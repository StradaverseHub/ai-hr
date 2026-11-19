/** Personnel employment identities are delivery subjects, never login principals. */
import { v9AddressRole } from './lifecycle-v9-recipient';

export type PersonnelManagerRecipient = {
  employmentId: string | null;
  name: string | null;
  email: string | null;
  reason: 'none' | 'ambiguous' | 'unavailable' | 'inactive' | 'missingEmail' | 'invalidEmail' | null;
};

export function managerRecipientResult(manager: PersonnelManagerRecipient): { key: string; name: string } | { reason: string } {
  const name = manager.name ? `Line manager ${manager.name}` : 'Line manager';
  const reasons = {
    none: 'no supervisor on the Personnel record',
    ambiguous: 'more than one current supervisor is recorded; HR must review the reporting line',
    unavailable: 'the supervisor recorded in Personnel is unavailable',
    inactive: `${name} has inactive employment`,
    missingEmail: `${name} has no work email`,
    invalidEmail: `${name} has an invalid work email`,
  };
  if (manager.reason) return { reason: reasons[manager.reason] };
  const key = manager.email ? v9AddressRole(manager.email) : null;
  if (!key) return { reason: manager.email ? reasons.invalidEmail : reasons.missingEmail };
  return { key, name: manager.name ?? 'Line manager' };
}
