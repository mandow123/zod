import * as SecureStore from 'expo-secure-store';
import type { WorkMode } from './components';

const WORK_MODE_KEY = 'kai.cloudpay.work-mode.v1';
const secureOptions: SecureStore.SecureStoreOptions = {
  keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
};

export async function loadWorkMode(): Promise<WorkMode> {
  return await SecureStore.getItemAsync(WORK_MODE_KEY, secureOptions) === 'provider' ? 'provider' : 'consumer';
}

export async function saveWorkMode(mode: WorkMode) {
  await SecureStore.setItemAsync(WORK_MODE_KEY, mode, secureOptions);
}
