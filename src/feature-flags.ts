import type { AppRouteKey } from './navigation';

/**
 * Mobile capability gates are intentionally compile-time defaults. A future
 * release may opt in through a reviewed configuration change; this candidate
 * must not expose Seedance until then.
 */
export const mobileFeatureFlags = Object.freeze({
  seedanceVideoEnabled: false,
});

export function normalizeMobileRoute(route: AppRouteKey): AppRouteKey {
  return route === 'video' && !mobileFeatureFlags.seedanceVideoEnabled ? 'home' : route;
}
