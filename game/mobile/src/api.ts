import { Platform } from 'react-native';
import * as SecureStore from 'expo-secure-store';
import type { GameView, History, Profile, RoomView } from './types';

const TOKEN_KEY = 'doujoy.session.v1';
const fallback = Platform.select({ android: 'http://10.0.2.2:4310', default: 'http://127.0.0.1:4310' });
const BASE_URL = (process.env.EXPO_PUBLIC_DOUJOY_API_URL || fallback)!.replace(/\/$/, '');

export class ApiError extends Error {
  constructor(readonly code: string, message: string, readonly status: number) {
    super(message);
  }
}

let token: string | null = null;

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(`${BASE_URL}${path}`, {
    ...options,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...options.headers,
    },
  });
  const payload = await response.json().catch(() => null) as ({ ok: boolean; error?: { code: string; message: string } } & T) | null;
  if (!response.ok || !payload?.ok) {
    throw new ApiError(payload?.error?.code ?? 'NETWORK_ERROR', payload?.error?.message ?? '连接失败，请检查服务端。', response.status);
  }
  return payload;
}

export async function bootstrap(): Promise<Profile> {
  token = await SecureStore.getItemAsync(TOKEN_KEY);
  if (token) {
    try { return (await request<{ profile: Profile }>('/v1/me')).profile; }
    catch (error) { if (!(error instanceof ApiError) || error.status !== 401) throw error; }
  }
  const session = await request<{ token: string; profile: Profile }>('/v1/sessions/guest', {
    method: 'POST', body: JSON.stringify({}),
  });
  token = session.token;
  await SecureStore.setItemAsync(TOKEN_KEY, token);
  return session.profile;
}

export async function me() {
  return (await request<{ profile: Profile }>('/v1/me')).profile;
}

export async function resumeSession() {
  return request<{ game: GameView | null; room: RoomView | null }>('/v1/resume');
}

export async function quickGame() {
  return (await request<{ game: GameView }>('/v1/games/quick', { method: 'POST', body: '{}' })).game;
}

function requestId() { return `${Date.now()}-${Math.random().toString(36).slice(2)}`; }

export async function gameAction(gameId: string, expectedSequence: number, kind: 'bid' | 'play' | 'pass', input: object = {}) {
  return request<{ game: GameView; profile: Profile }>(`/v1/games/${gameId}/${kind}`, {
    method: 'POST', body: JSON.stringify({ ...input, expectedSequence }), headers: { 'x-request-id': requestId() },
  });
}

export async function claimRelief() {
  return request<{ claimed: boolean; profile: Profile }>('/v1/relief', { method: 'POST', body: '{}' });
}

export async function history() {
  return request<History>('/v1/history');
}

export async function createRoom() {
  return (await request<{ room: RoomView }>('/v1/rooms', { method: 'POST', body: '{}' })).room;
}

export async function joinRoom(code: string) {
  return (await request<{ room: RoomView }>('/v1/rooms/join', { method: 'POST', body: JSON.stringify({ code }) })).room;
}

export async function getRoom(roomId: string, signal?: AbortSignal) {
  return (await request<{ room: RoomView }>(`/v1/rooms/${roomId}`, { signal })).room;
}

export async function waitForRoom(roomId: string, version: number, signal?: AbortSignal, timeoutMs = 20_000) {
  const query = new URLSearchParams({ version: String(version), timeoutMs: String(timeoutMs) });
  return request<{ room: RoomView; version: number; changed: boolean; timedOut: boolean }>(
    `/v1/rooms/${roomId}/wait?${query}`,
    { signal },
  );
}

export async function startRoom(roomId: string) {
  return request<{ room: RoomView; game: GameView }>(`/v1/rooms/${roomId}/start`, { method: 'POST', body: '{}' });
}

export async function leaveRoom(roomId: string) {
  return request<{ left: true }>(`/v1/rooms/${roomId}/leave`, { method: 'POST', body: '{}' });
}

export async function getGame(gameId: string, signal?: AbortSignal) {
  return (await request<{ game: GameView }>(`/v1/games/${gameId}`, { signal })).game;
}

export async function waitForGame(gameId: string, version: number, signal?: AbortSignal, timeoutMs = 20_000) {
  const query = new URLSearchParams({ version: String(version), timeoutMs: String(timeoutMs) });
  return request<{ game: GameView; version: number; changed: boolean; timedOut: boolean }>(
    `/v1/games/${gameId}/wait?${query}`,
    { signal },
  );
}

export async function reportGame(gameId: string, reason: 'collusion' | 'cheating' | 'harassment' | 'other') {
  return request<{ report: { id: string; created: boolean; status: 'open' } }>('/v1/reports', {
    method: 'POST', body: JSON.stringify({ gameId, reason }),
  });
}
