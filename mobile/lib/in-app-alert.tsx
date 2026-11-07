import { useEffect, useLayoutEffect, useRef, useSyncExternalStore, type ReactNode } from 'react';
import { Alert as NativeAlert, AppState, BackHandler, Platform, Pressable, ScrollView, View } from 'react-native';
import { usePathname } from 'expo-router';
import { authGeneration } from './auth';
import { DesignText as Text, useTenantDesign } from './design';
import { t } from './i18n';
import { useSession } from './session';
import { createInAppAlertState, type InAppAlertButton } from './in-app-alert-state';

const dialogs = createInAppAlertState();

/** Android OS dialogs steal window focus and lock this app. Use a same-window confirmation; never ignore blur. */
export const InAppAlert = {
  alert(title: string, message?: string, buttons?: readonly InAppAlertButton[]) {
    if (Platform.OS !== 'android') { NativeAlert.alert(title, message, buttons ? [...buttons] : undefined); return; }
    dialogs.show(title, message, buttons);
  },
};

/** Mounted only inside the unlocked shell. No Modal, extra Activity, queue, storage or security exception. */
export function InAppAlertBoundary({ children }: { children: ReactNode }) {
  const path = usePathname();
  const { employmentId } = useSession();
  const { palette, appearance } = useTenantDesign();
  const scope = useRef({ path, employmentId });
  scope.current = { path, employmentId };
  const dialog = useSyncExternalStore(dialogs.subscribe, dialogs.getSnapshot, dialogs.getSnapshot);
  const generation = authGeneration();
  useLayoutEffect(() => {
    if (Platform.OS !== 'android') return;
    return dialogs.attach(() => ({ generation: authGeneration(), route: scope.current.path, employmentId: scope.current.employmentId, active: AppState.currentState === 'active' }));
  }, []);
  useLayoutEffect(() => { dialogs.reconcile(); }, [path, employmentId, generation]);
  useEffect(() => {
    if (Platform.OS !== 'android') return;
    const state = AppState.addEventListener('change', value => { if (value !== 'active') dialogs.clear(); });
    const blur = AppState.addEventListener('blur', () => dialogs.clear());
    const back = BackHandler.addEventListener('hardwareBackPress', () => {
      if (!dialogs.getSnapshot()) return false;
      dialogs.dismiss(); return true;
    });
    return () => { state.remove(); blur.remove(); back.remove(); };
  }, []);
  if (Platform.OS !== 'android') return <>{children}</>;
  return <View style={{ flex: 1 }}>
    <View style={{ flex: 1 }} pointerEvents={dialog ? 'none' : 'auto'} importantForAccessibility={dialog ? 'no-hide-descendants' : 'auto'}>{children}</View>
    {dialog && <View accessibilityViewIsModal importantForAccessibility="yes" style={{ position: 'absolute', top: 0, bottom: 0, left: 0, right: 0, zIndex: 1000, padding: 20, justifyContent: 'center', alignItems: 'center', backgroundColor: 'rgba(0,0,0,0.60)' }}>
      <View style={{ width: '100%', maxWidth: 560, maxHeight: '85%', padding: 20, gap: 16, borderRadius: 2, borderWidth: 1, borderColor: palette.border, backgroundColor: palette.card }}>
        <Text accessibilityRole="header" style={{ color: palette.text, fontSize: 22, fontWeight: '600' }}>{dialog.title}</Text>
        {!!dialog.message && <ScrollView style={{ flexShrink: 1 }} contentContainerStyle={{ paddingBottom: 4 }}><Text style={{ color: palette.text, fontSize: 16, lineHeight: 24 }}>{dialog.message}</Text></ScrollView>}
        <View style={{ gap: 8 }}>{dialog.buttons.map((button, index) => {
          const primary = button.style !== 'cancel' && button.style !== 'destructive';
          const text = button.text ?? t('pickerDone');
          return <Pressable key={`${dialog.id}:${index}`} accessibilityRole="button" accessibilityLabel={text} onPress={() => dialogs.press(dialog.id, index)}
            style={({ pressed }) => ({ minHeight: 52, padding: 12, justifyContent: 'center', alignItems: 'center', borderRadius: 2, borderWidth: 1, borderColor: palette.border, opacity: pressed ? .7 : 1, backgroundColor: primary ? palette.button : palette.card })}>
            <Text style={{ fontSize: 16, fontWeight: '600', textAlign: 'center', color: button.style === 'destructive' ? appearance === 'dark' ? '#ffb4ab' : '#b42318' : primary ? palette.onButton : palette.text }}>{text}</Text>
          </Pressable>;
        })}</View>
      </View>
    </View>}
  </View>;
}
