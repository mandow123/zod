import * as SecureStore from 'expo-secure-store';

const KEY_PREFIX = 'kai.cloudpay.delivery-draft.v1.';
const secureOptions: SecureStore.SecureStoreOptions = {
  keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
};

export type DeliveryDraft = Readonly<{
  endpoint: string;
  username: string;
  instructions: string;
}>;

function key(orderId: string) {
  return `${KEY_PREFIX}${orderId}`;
}

function valid(value: unknown): value is DeliveryDraft {
  if (!value || typeof value !== 'object') return false;
  const draft = value as Partial<DeliveryDraft>;
  return typeof draft.endpoint === 'string' && draft.endpoint.length <= 2_000
    && typeof draft.username === 'string' && draft.username.length <= 2_000
    && typeof draft.instructions === 'string' && draft.instructions.length <= 2_000;
}

export async function loadDeliveryDraft(orderId: string) {
  const draftKey = key(orderId);
  const raw = await SecureStore.getItemAsync(draftKey, secureOptions);
  if (!raw) return null;
  try {
    const value: unknown = JSON.parse(raw);
    if (valid(value)) return value;
  } catch {
    // Invalid device-only data is removed below.
  }
  await SecureStore.deleteItemAsync(draftKey, secureOptions);
  return null;
}

export async function saveDeliveryDraft(orderId: string, draft: DeliveryDraft) {
  await SecureStore.setItemAsync(key(orderId), JSON.stringify(draft), secureOptions);
}

export async function clearDeliveryDraft(orderId: string) {
  await SecureStore.deleteItemAsync(key(orderId), secureOptions);
}
