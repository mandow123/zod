export type PrimaryTabKey = 'home' | 'market' | 'assets' | 'messages' | 'profile';

export type AppRouteKey = PrimaryTabKey
  | 'credits'
  | 'orders'
  | 'workspace'
  | 'resources'
  | 'publish'
  | 'creator';

export const primaryTabFor: Readonly<Record<AppRouteKey, PrimaryTabKey>> = Object.freeze({
  home: 'home',
  market: 'market',
  assets: 'assets',
  messages: 'messages',
  profile: 'profile',
  credits: 'assets',
  orders: 'assets',
  workspace: 'assets',
  resources: 'assets',
  publish: 'assets',
  creator: 'profile',
});
