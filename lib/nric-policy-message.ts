/** Safe identity-policy text: no NRIC or hidden holder details are interpolated. */
export const NRIC_DUPLICATE_MESSAGE = 'This NRIC already exists in another employee record. Duplicate NRIC numbers are not allowed under the current People General Settings.';
export const NRIC_FILE_DUPLICATE_MESSAGE = 'Duplicate ic_number in this file. Duplicate NRIC numbers are not allowed under the current People General Settings.';
export const NRIC_AMBIGUOUS_MESSAGE = 'Employee identity is ambiguous. Use a unique Employee ID.';
export function nricPolicyMessage(message: string, translate: (key: 'duplicate' | 'duplicateFile' | 'ambiguous') => string) {
  if (message === NRIC_AMBIGUOUS_MESSAGE) return translate('ambiguous');
  if (message === NRIC_DUPLICATE_MESSAGE) return translate('duplicate');
  if (message === NRIC_FILE_DUPLICATE_MESSAGE) return translate('duplicateFile');
  return message;
}
