/**
 * What the app lock can use on this phone, for the lock screen's wording and Settings → Security. Reading this
 * changes nothing: the lock itself (lib/session.tsx, lib/session-state.ts) always runs, accepts strong biometrics with
 * the device passcode as fallback, and signs out when the phone has no credential at all. There is no switch to turn
 * the lock off: payslips and personal records sit behind it.
 */
import * as LocalAuthentication from 'expo-local-authentication';
import { useEffect, useState } from 'react';
import { Platform } from 'react-native';

export type LockMethod = 'face' | 'fingerprint' | 'iris' | 'passcode' | 'none';
export type LockCapability = { method: LockMethod; biometricHardware: boolean; biometricEnrolled: boolean };

/** The strongest method this phone will offer when the lock prompts. */
export async function lockCapability(): Promise<LockCapability> {
  const [hardware, level, types] = await Promise.all([
    LocalAuthentication.hasHardwareAsync(),
    LocalAuthentication.getEnrolledLevelAsync(),
    LocalAuthentication.supportedAuthenticationTypesAsync(),
  ]);
  const enrolled = level >= LocalAuthentication.SecurityLevel.BIOMETRIC_STRONG;
  const T = LocalAuthentication.AuthenticationType;
  const biometric: LockMethod = types.includes(T.FACIAL_RECOGNITION) ? 'face' : types.includes(T.FINGERPRINT) ? 'fingerprint' : types.includes(T.IRIS) ? 'iris' : 'none';
  const method: LockMethod = enrolled && biometric !== 'none' ? biometric : level >= LocalAuthentication.SecurityLevel.SECRET ? 'passcode' : 'none';
  return { method, biometricHardware: hardware, biometricEnrolled: enrolled };
}

export function useLockCapability(): LockCapability | null {
  const [value, setValue] = useState<LockCapability | null>(null);
  useEffect(() => { let live = true; void lockCapability().then((v) => { if (live) setValue(v); }).catch(() => {}); return () => { live = false; }; }, []);
  return value;
}

/** The platform's own name for the biometric. */
export function biometricName(method: LockMethod): 'faceId' | 'touchId' | 'faceUnlock' | 'fingerprint' | 'iris' | 'passcode' | 'none' {
  if (method === 'face') return Platform.OS === 'ios' ? 'faceId' : 'faceUnlock';
  if (method === 'fingerprint') return Platform.OS === 'ios' ? 'touchId' : 'fingerprint';
  return method;
}
