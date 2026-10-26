import {requireOptionalNativeModule} from 'expo';
import type {NativeIntegrityModule} from './AihrIntegrity.types';
// Older binaries / Expo Go have no bridge. Never substitute an extractable JavaScript key.
export default requireOptionalNativeModule<NativeIntegrityModule>('AihrIntegrity');
