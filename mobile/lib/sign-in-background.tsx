/** Original Opal mountain artwork, restored by owner request. Decorative and bundled offline. */
import { Image, StyleSheet, View } from 'react-native';
import { useTenantDesign } from './design';
export function SignInBackground() {
  const { appearance, palette } = useTenantDesign();
  return <View pointerEvents="none" accessible={false} accessibilityElementsHidden importantForAccessibility="no-hide-descendants" style={StyleSheet.absoluteFill}>
    <Image accessible={false} resizeMode="cover" source={appearance === 'dark' ? require('../assets/sign-in/mountains-dark.png') : require('../assets/sign-in/mountains-light.png')} style={StyleSheet.absoluteFill}/>
    <View style={[StyleSheet.absoluteFill, { experimental_backgroundImage: `linear-gradient(180deg, ${palette.bg}00 20%, ${palette.bg}55 48%, ${palette.bg} 95%)` }]}/>
  </View>;
}
