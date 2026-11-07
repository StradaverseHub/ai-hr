/** A flat public surface keeps credential controls legible in both appearances. */
import { StyleSheet, View } from 'react-native';
import { useTenantDesign } from './design';
export function SignInBackground() {
  const { palette } = useTenantDesign();
  return <View pointerEvents="none" accessible={false} style={[StyleSheet.absoluteFill, { backgroundColor: palette.bg }]} />;
}
