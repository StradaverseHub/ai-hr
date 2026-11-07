import { isLoaded } from 'expo-font';
import type { TextStyle } from 'react-native';

/** Bundled locally so the brand and every authentication state work offline. */
export const FIELD_NOTES_FONTS = {
  FieldRegular: require('../assets/fonts/Manrope_400Regular.ttf'),
  FieldMedium: require('../assets/fonts/Manrope_500Medium.ttf'),
  FieldSemiBold: require('../assets/fonts/Manrope_600SemiBold.ttf'),
  FieldBold: require('../assets/fonts/Manrope_700Bold.ttf'),
  FieldDisplay: require('../assets/fonts/Manrope_800ExtraBold.ttf'),
  FieldEditorial: require('../assets/fonts/Newsreader_700Bold.ttf'),
};

export function fieldTypography(style: TextStyle): TextStyle {
  if (style.fontFamily) return {};
  const weight = Number(style.fontWeight) || (style.fontWeight === 'bold' ? 700 : 400);
  const family = weight >= 800 ? 'FieldDisplay' : weight >= 700 ? 'FieldBold' : weight >= 600 ? 'FieldSemiBold' : weight >= 500 ? 'FieldMedium' : 'FieldRegular';
  return isLoaded(family) ? { fontFamily: family, fontWeight: 'normal' } : {};
}

