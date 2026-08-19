import Constants from 'expo-constants';
import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';
import { apiRequest } from './api-client';
import { validExpoProjectId } from './project-id';

export type AccountSession = Readonly<{
  id: string;
  device: Readonly<{ deviceId: string; appVersion: string; platform: 'android' | 'ios' }>;
  lastSeenAt: string;
  expiresAt: string;
  current: boolean;
}>;

export type AccountDeletion = Readonly<{
  id: string;
  status: 'requested' | 'cooling_off' | 'blocked_by_legal_hold' | 'processing' | 'completed' | 'cancelled';
  coolingOffUntil: string;
  requestedAt: string;
  legalHoldReason: string | null;
}>;

export type PushStatus = Readonly<{
  providerAvailable: boolean;
  pushEnabled: boolean;
  installation: null | Readonly<{
    id: string; deviceId: string; platform: 'android' | 'ios'; locale: string;
    timezone: string; appVersion: string; updatedAt: string;
  }>;
}>;

export async function listAccountSessions() {
  const response = await apiRequest<{ ok: true; sessions: AccountSession[] }>('/mobile/v1/auth/sessions', {
    auth: 'required', retry: true,
  });
  return response.sessions;
}

export async function revokeAccountSession(sessionId: string) {
  const response = await apiRequest<{ ok: true; revoked: boolean }>(
    `/mobile/v1/auth/sessions/${encodeURIComponent(sessionId)}`,
    { method: 'DELETE', auth: 'required', retry: false },
  );
  return response.revoked;
}

export async function loadAccountDeletion() {
  const response = await apiRequest<{ ok: true; request: AccountDeletion | null }>('/mobile/v1/account/deletion', {
    auth: 'required', retry: true,
  });
  return response.request;
}

export async function requestAccountDeletion(reauthenticationToken: string, reason?: string) {
  const response = await apiRequest<{ ok: true; request: AccountDeletion }>('/mobile/v1/account/deletion', {
    method: 'POST', auth: 'required', retry: false,
    body: { reauthenticationToken, ...(reason?.trim() ? { reason: reason.trim() } : {}) },
  });
  return response.request;
}

export async function cancelAccountDeletion() {
  const response = await apiRequest<{ ok: true; cancelled: boolean }>('/mobile/v1/account/deletion', {
    method: 'DELETE', auth: 'required', retry: false,
  });
  return response.cancelled;
}

export async function loadPushStatus() {
  const response = await apiRequest<{ ok: true } & PushStatus>('/mobile/v1/devices/push', {
    auth: 'required', retry: true,
  });
  return response;
}

export function pushProjectId() {
  const configured = Constants.easConfig?.projectId ?? Constants.expoConfig?.extra?.eas?.projectId;
  return validExpoProjectId(configured) ? configured.trim() : null;
}

export async function enablePushNotifications() {
  if (Constants.expoConfig?.extra?.pushNotificationsEnabled !== true) {
    throw new Error('此安装包未启用正式推送，不会申请系统通知权限。');
  }
  const projectId = pushProjectId();
  if (!validExpoProjectId(projectId)) throw new Error('正式推送项目尚未正确绑定，当前不会申请系统通知权限。');
  if (Platform.OS === 'android') {
    await Notifications.setNotificationChannelAsync('cloudpay-activity', {
      name: '订单与账户动态',
      importance: Notifications.AndroidImportance.HIGH,
      vibrationPattern: [0, 250, 250, 250],
      lightColor: '#166534',
      sound: 'default',
    });
  }
  let permission = await Notifications.getPermissionsAsync();
  if (!permission.granted) permission = await Notifications.requestPermissionsAsync();
  if (!permission.granted) throw new Error('系统通知权限未开启，可在手机设置中重新授权。');
  const token = await Notifications.getExpoPushTokenAsync({ projectId });
  const resolved = Intl.DateTimeFormat().resolvedOptions();
  const response = await apiRequest<{ ok: true; installation: { pushEnabled: boolean } }>('/mobile/v1/devices/push', {
    method: 'PUT', auth: 'required', retry: false,
    body: {
      pushToken: token.data,
      locale: resolved.locale || 'zh-CN',
      timezone: resolved.timeZone || 'Asia/Shanghai',
    },
  });
  return response.installation.pushEnabled;
}

export async function disablePushNotifications() {
  const response = await apiRequest<{ ok: true; disabled: boolean }>('/mobile/v1/devices/push', {
    method: 'DELETE', auth: 'required', retry: false,
  });
  return response.disabled;
}
