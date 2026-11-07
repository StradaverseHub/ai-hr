/** Native presentation only. Published schema-2 compositions keep their own theme. */
import { mobilePalette, type MobileDesign } from '../../lib/mobile-design';
import { FIELD_NOTES } from './field-notes';

export function nativeMobilePalette(design: MobileDesign, appearance: 'dark' | 'light') {
  const prior = mobilePalette(design, appearance);
  if (design.schemaVersion === 2) return prior;
  return {
    ...prior,
    ...FIELD_NOTES[appearance],
    ...(design.accent === 'jade' ? {} : { accent: prior.accent, button: prior.button, onButton: prior.onButton }),
  };
}
