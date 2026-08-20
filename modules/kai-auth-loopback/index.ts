import { requireNativeModule } from 'expo-modules-core';

export type KaiLoopbackCallback = Readonly<{
  kind: 'code' | 'error';
  state: string;
  issuer: string;
  code?: string;
  error?: string;
  receivedAt?: number;
}>;

export type PersistedKaiLoopbackCallback = KaiLoopbackCallback & Readonly<{
  attemptId: string;
  receivedAt: number;
}>;

type KaiAuthLoopbackNativeModule = Readonly<{
  startAsync(attemptId: string, state: string, issuer: string): Promise<{ redirectUri: string }>;
  waitForCallbackAsync(attemptId: string): Promise<KaiLoopbackCallback>;
  cancelAsync(attemptId: string): Promise<void>;
  isActiveAsync(attemptId: string): Promise<boolean>;
  peekPersistedCallbackAsync(attemptId: string): Promise<PersistedKaiLoopbackCallback | null>;
  acknowledgePersistedCallbackAsync(attemptId: string, state: string): Promise<void>;
}>;

const nativeModule = requireNativeModule<KaiAuthLoopbackNativeModule>('KaiAuthLoopback');

export const startKaiAuthLoopbackAsync = nativeModule.startAsync.bind(nativeModule);
export const waitForKaiAuthLoopbackCallbackAsync = nativeModule.waitForCallbackAsync.bind(nativeModule);
export const cancelKaiAuthLoopbackAsync = nativeModule.cancelAsync.bind(nativeModule);
export const isKaiAuthLoopbackActiveAsync = nativeModule.isActiveAsync.bind(nativeModule);
export const peekPersistedKaiAuthCallbackAsync = nativeModule.peekPersistedCallbackAsync.bind(nativeModule);
export const acknowledgePersistedKaiAuthCallbackAsync = nativeModule.acknowledgePersistedCallbackAsync.bind(nativeModule);
