import type { NotificationResponse } from 'expo-notifications';
import { useEffect } from 'react';
import type { AppStateStatus } from 'react-native';

type RemovableSubscription = Readonly<{ remove: () => void }>;

export type AppLifecycleAdapters = Readonly<{
  linking: Readonly<{
    getInitialURL: () => Promise<string | null>;
    addEventListener: (event: 'url', listener: (event: Readonly<{ url: string }>) => void) => RemovableSubscription;
  }>;
  appState: Readonly<{
    addEventListener: (event: 'change', listener: (state: AppStateStatus) => void) => RemovableSubscription;
  }>;
  notifications: Readonly<{
    getLastNotificationResponseAsync: () => Promise<NotificationResponse | null>;
    clearLastNotificationResponseAsync: () => Promise<void>;
    addNotificationResponseReceivedListener: (listener: (response: NotificationResponse) => void) => RemovableSubscription;
  }>;
}>;

export type AppLifecycleCallbacks = Readonly<{
  onUrl: (url: string | null, isActive: () => boolean) => void | Promise<void>;
  onAppActive: () => void;
  onNotificationResponse: (response: NotificationResponse | null) => void;
}>;

/** Runtime-testable URL subscription with a guard at the async callback boundary. */
export function subscribeToAppUrls(
  linking: AppLifecycleAdapters['linking'],
  onUrl: AppLifecycleCallbacks['onUrl'],
) {
  let active = true;
  const isActive = () => active;
  const handleUrl = (url: string | null) => {
    if (!active) return;
    void onUrl(url, isActive);
  };
  void linking.getInitialURL().then(handleUrl);
  const subscription = linking.addEventListener('url', ({ url }) => { handleUrl(url); });
  return () => { active = false; subscription.remove(); };
}

export function subscribeToAppState(
  appState: AppLifecycleAdapters['appState'],
  onAppActive: AppLifecycleCallbacks['onAppActive'],
) {
  const subscription = appState.addEventListener('change', (state) => {
    if (state === 'active') onAppActive();
  });
  return () => subscription.remove();
}

export function subscribeToNotifications(
  notifications: AppLifecycleAdapters['notifications'],
  onNotificationResponse: AppLifecycleCallbacks['onNotificationResponse'],
) {
  let active = true;
  void notifications.getLastNotificationResponseAsync().then((response) => {
    if (!active) return;
    onNotificationResponse(response);
    if (response) void notifications.clearLastNotificationResponseAsync();
  });
  const subscription = notifications.addNotificationResponseReceivedListener(onNotificationResponse);
  return () => { active = false; subscription.remove(); };
}

/** Keeps platform subscriptions at the app boundary and pairs each with cleanup. */
export function useAppLifecycle(
  { onUrl, onAppActive, onNotificationResponse }: AppLifecycleCallbacks,
  { linking, appState, notifications }: AppLifecycleAdapters,
) {
  useEffect(() => subscribeToAppUrls(linking, onUrl), [linking, onUrl]);

  useEffect(() => subscribeToAppState(appState, onAppActive), [appState, onAppActive]);

  useEffect(
    () => subscribeToNotifications(notifications, onNotificationResponse),
    [notifications, onNotificationResponse],
  );
}
