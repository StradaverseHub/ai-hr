/**
 * App-wide session state. Four states, and the difference between two of them is the point:
 *   loading   — reading the Keychain on launch;
 *   locked    — a session exists, the OS biometric/passcode prompt has not been passed yet;
 *   signedOut — no session, or the server/WorkOS refused it;
 *   signedIn  — ready.
 * An outage never moves signedIn → signedOut (lib/errors.ts). OS biometric unlock hands the app a yes/no
 * only — no biometric data — so it is not biometric processing under PDPA (ADR-0088 §1).
 */
import * as LocalAuthentication from 'expo-local-authentication';
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { hasStoredSession, signOut as clearTokens } from './auth';
import { t } from './i18n';

type Status = 'loading' | 'locked' | 'signedOut' | 'signedIn';

type Session = {
  status: Status;
  /** The employment the employee is acting as (the picker); null ⇒ the server's default. */
  employmentId: string | null;
  setEmploymentId: (id: string | null) => void;
  markSignedIn: () => void;
  unlock: () => Promise<void>;
  signOut: () => Promise<void>;
};

const Ctx = createContext<Session | null>(null);

async function deviceCanUnlock(): Promise<boolean> {
  return (await LocalAuthentication.hasHardwareAsync()) && (await LocalAuthentication.isEnrolledAsync());
}

export function SessionProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<Status>('loading');
  const [employmentId, setEmploymentId] = useState<string | null>(null);

  const unlock = useCallback(async () => {
    if (!(await deviceCanUnlock())) {
      setStatus('signedIn'); // no biometrics and no passcode enrolled: nothing to unlock with
      return;
    }
    const r = await LocalAuthentication.authenticateAsync({
      promptMessage: t('unlockPrompt'),
      fallbackLabel: t('usePasscode'),
      disableDeviceFallback: false,
    });
    if (r.success) setStatus('signedIn');
  }, []);

  useEffect(() => {
    let live = true;
    hasStoredSession().then((has) => {
      if (!live) return;
      setStatus(has ? 'locked' : 'signedOut');
      if (has) void unlock();
    });
    return () => {
      live = false;
    };
  }, [unlock]);

  const signOut = useCallback(async () => {
    await clearTokens();
    setEmploymentId(null);
    setStatus('signedOut');
  }, []);

  const markSignedIn = useCallback(() => setStatus('signedIn'), []);

  const value = useMemo(
    () => ({ status, employmentId, setEmploymentId, markSignedIn, unlock, signOut }),
    [status, employmentId, markSignedIn, unlock, signOut],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useSession(): Session {
  const s = useContext(Ctx);
  if (!s) throw new Error('useSession outside SessionProvider');
  return s;
}
