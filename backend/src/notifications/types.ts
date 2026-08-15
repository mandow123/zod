export type NotificationCategory = 'order' | 'payment' | 'delivery' | 'market' | 'account' | 'system';

export type NotificationRecord = Readonly<{
  id: string;
  userId: string;
  category: NotificationCategory;
  title: string;
  body: string;
  data: Record<string, unknown>;
  readAt: Date | null;
  createdAt: Date;
}>;

export type DeviceInstallationRecord = Readonly<{
  id: string;
  userId: string;
  deviceId: string;
  platform: 'android' | 'ios';
  pushEnabled: boolean;
  locale: string;
  timezone: string;
  appVersion: string;
  updatedAt: Date;
}>;
