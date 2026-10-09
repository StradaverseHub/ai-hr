import * as LocalAuthentication from 'expo-local-authentication';
import * as ScreenCapture from 'expo-screen-capture';
import * as WebBrowser from 'expo-web-browser';
import { createContext, useContext, useEffect, useMemo, useState, useSyncExternalStore, type ReactNode } from 'react';
import { AppState, Platform } from 'react-native';
import { assertAuthGeneration, hasStoredSession, redirectUri, signOut as clearTokens, workosLogoutUrl } from './auth';
import { t } from './i18n';
import { createSessionState, type Visibility } from './session-state';

type Controller = ReturnType<typeof createSessionState>;
type Session = ReturnType<Controller['getSnapshot']> & {
  setEmploymentId: Controller['setEmploymentId'];
  markSignedIn: (owner: number) => Promise<void>;
  unlock: Controller['unlock'];
  signOut: Controller['signOut'];
};
const Ctx = createContext<Session | null>(null);

/** Native protection is enabled before protected data screens mount; no runtime permission prompt. */
let screenProtection: Promise<void> | null = null;
function protectScreen() {
  if (!screenProtection) {
    screenProtection = (async () => {
      await ScreenCapture.preventScreenCaptureAsync('aihr-session');
      if (Platform.OS === 'ios') await ScreenCapture.enableAppSwitcherProtectionAsync(1);
    })().catch((error: unknown) => { screenProtection = null; throw error; });
  }
  return screenProtection;
}
function visibility(value: string | null): Visibility {
  return value === 'active' ? 'active' : value === 'inactive' ? 'inactive' : 'background';
}

export function SessionProvider({ children }: { children: ReactNode }) {
  const [state] = useState(() => createSessionState({
    async hasStoredSession() { await protectScreen(); return hasStoredSession(); },
    async canUnlock() {
      await protectScreen();
      // SECRET includes a passcode even when no biometric hardware/enrollment exists.
      return (await LocalAuthentication.getEnrolledLevelAsync()) >= LocalAuthentication.SecurityLevel.SECRET;
    },
    async authenticate() {
      return (await LocalAuthentication.authenticateAsync({
        promptMessage: t('unlockPrompt'), fallbackLabel: t('usePasscode'),
        disableDeviceFallback: false, biometricsSecurityLevel: 'strong',
      })).success;
    },
    clearTokens,
  }, visibility(AppState.currentState)));
  const snapshot = useSyncExternalStore(state.subscribe, state.getSnapshot, state.getSnapshot);

  useEffect(() => {
    const change = AppState.addEventListener('change', (value) => state.setVisibility(visibility(value)));
    const blur = Platform.OS === 'android' ? AppState.addEventListener('blur', state.blur) : null;
    void state.initialize();
    return () => { change.remove(); blur?.remove(); state.dispose(); };
  }, [state]);
  const value = useMemo(() => ({
    ...snapshot, setEmploymentId: state.setEmploymentId, unlock: state.unlock,
    async signOut() {
      const logoutUrl = workosLogoutUrl();
      await state.signOut(); // local removal is independent of provider reachability
      if (logoutUrl) {
        try { await WebBrowser.openAuthSessionAsync(logoutUrl, redirectUri()); }
        catch { /* Local logout succeeded; provider revocation must be verified on staging. */ }
      }
    },
    async markSignedIn(owner: number) { await protectScreen(); assertAuthGeneration(owner); state.markSignedIn(); },
  }), [snapshot, state]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
export function useSession(): Session {
  const session = useContext(Ctx);
  if (!session) throw new Error('useSession outside SessionProvider');
  return session;
}
