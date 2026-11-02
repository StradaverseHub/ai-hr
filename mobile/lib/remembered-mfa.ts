import * as SecureStore from 'expo-secure-store';
import { File, Paths } from 'expo-file-system';
import { identityNamespace } from './config';
import { createRememberedMfaStore } from './remembered-mfa-store';
const KEY = 'aihr.rememberedMfa.v1';
const options = { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY };
const marker = () => new File(Paths.document, 'aihr-mfa-installation-v1');
const store = createRememberedMfaStore({
  read: () => SecureStore.getItemAsync(KEY, options),
  write: value => SecureStore.setItemAsync(KEY, value, options),
  remove: () => SecureStore.deleteItemAsync(KEY, options),
  markerExists: () => marker().exists,
  createMarker: () => marker().write('1'),
});
export const readRememberedMfa = (organization: string, username: string, assertCurrent: () => void) =>
  store.read({ namespace: identityNamespace(), organization, username }, assertCurrent);
export const saveRememberedMfa = (organization: string, username: string, token: string, seconds: number, assertCurrent: () => void) =>
  store.save({ namespace: identityNamespace(), organization, username }, token, seconds, assertCurrent);
