/** Board c074c6b8 test support: the real catalogues through next-intl's own translator, as the screen and routes use them. */
import {createTranslator} from 'next-intl';
import en from '../messages/en.json';import ms from '../messages/ms.json';import zh from '../messages/zh.json';import ta from '../messages/ta.json';import th from '../messages/th.json';import vi from '../messages/vi.json';
import type {LabelProblemTranslator} from '../lib/system-label-import-problems';
export const LABEL_LOCALES=[['en',en],['ms',ms],['zh',zh],['ta',ta],['th',th],['vi',vi]] as const;
/** A strict root translator: a missing key fails the test instead of printing its path. */
export function labelRootTranslator(locale:string,messages:object):LabelProblemTranslator{
 return createTranslator({locale,messages:messages as never,onError:error=>{throw error;}}) as unknown as LabelProblemTranslator;
}
