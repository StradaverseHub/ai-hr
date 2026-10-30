import * as LocalAuthentication from 'expo-local-authentication';
import * as ScreenCapture from 'expo-screen-capture';
import * as WebBrowser from 'expo-web-browser';
import { createContext, useCallback, useContext, useEffect, useMemo, useState, useSyncExternalStore, type ReactNode } from 'react';
import { AppState, Platform } from 'react-native';
import { assertAuthGeneration, hasStoredSession, redirectUri, signOut as clearTokens, workosLogoutUrl } from './auth';
import { t } from './i18n';
import { createSessionState, type Visibility } from './session-state';
import { sweepProtectedDocuments } from './protected-document';
import { releasePushOnExit } from './push-core';

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
/**
 * Screenshots and screen recordings stay blocked for the whole life of the app (Android FLAG_SECURE; on iOS a secure
 * canvas that hides the window from screenshots plus a cover while the screen is recorded or mirrored). iOS attaches
 * that canvas to the CURRENT key window, which can change (the hosted sign-in sheet, a share sheet), so protection is
 * asserted again every time the app returns to the foreground. Each assertion uses a fresh tag because the library
 * skips a tag it already holds; the native call is idempotent for an unchanged window. Never released while running.
 */
let protectionRound = 0;
async function reassertScreenProtection() {
  if (!screenProtection) return; // not yet protected at all: the gate's own protectScreen() runs first and must succeed
  protectionRound += 1;
  try { await ScreenCapture.preventScreenCaptureAsync(`aihr-session-${protectionRound}`); }
  catch { /* No key window yet: the next foreground (or the launch assertion) retries. */ }
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
    // Logout (explicit, failed unlock or revoked session) removes any protected document first.
    async clearTokens() { sweepProtectedDocuments(); await clearTokens(); },
  }, visibility(AppState.currentState)));
  const snapshot = useSyncExternalStore(state.subscribe, state.getSnapshot, state.getSnapshot);

  useEffect(() => {
    sweepProtectedDocuments(); // launch: leftovers of a killed process (launch protection runs inside hasStoredSession)
    // Biometrics prompt by themselves ONCE per lock when the app comes back; a cancelled prompt is not re-raised (the
    // lock screen's button stays), so dismissing Face ID can never loop. Unlocking re-arms it.
    let prompted = true; // launch: initialize() already prompts once
    const armed = state.subscribe(() => { if (state.getSnapshot().status === 'signedIn') prompted = false; });
    const change = AppState.addEventListener('change', (value) => {
      const next = visibility(value);
      if (next === 'background') sweepProtectedDocuments({ keepSharing: true }); // a document in an OS share is spared (M09)
      state.setVisibility(next);
      if (next === 'active') {
        const auto = state.getSnapshot().status === 'locked' && !state.getSnapshot().unlocking && !prompted;
        if (auto) prompted = true;
        // Protection is re-attached to the current window BEFORE any automatic unlock can show private screens.
        void reassertScreenProtection().then(() => { if (auto && state.getSnapshot().status === 'locked') void state.unlock(); });
      }
    });
    const blur = Platform.OS === 'android' ? AppState.addEventListener('blur', state.blur) : null;
    void state.initialize();
    return () => { armed(); change.remove(); blur?.remove(); state.dispose(); };
  }, [state]);
  // A document fetched for one employment never survives a switch to another. Stable, as before.
  const setEmploymentId = useCallback((employmentId: string | null) => {
    if (employmentId !== state.getSnapshot().employmentId) sweepProtectedDocuments();
    state.setEmploymentId(employmentId);
  }, [state]);
  const value = useMemo(() => ({
    ...snapshot, setEmploymentId, unlock: state.unlock,
    async signOut() {
      const logoutUrl = workosLogoutUrl();
      // M10/D8: revoke this phone's push binding and drop its shift reminders while the tokens still exist (bounded).
      await releasePushOnExit('logout', state.getSnapshot().employmentId);
      await state.signOut(); // local removal is independent of provider reachability
      if (logoutUrl) {
        try { await WebBrowser.openAuthSessionAsync(logoutUrl, redirectUri()); }
        catch { /* Local logout succeeded; provider revocation must be verified on staging. */ }
      }
    },
    async markSignedIn(owner: number) { await protectScreen(); assertAuthGeneration(owner); state.markSignedIn(); },
  }), [snapshot, state, setEmploymentId]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
export function useSession(): Session {
  const session = useContext(Ctx);
  if (!session) throw new Error('useSession outside SessionProvider');
  return session;
}
