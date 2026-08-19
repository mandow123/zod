import { useEffect, useRef } from 'react';
import { ApiError, getGame, waitForRoom } from './api';
import type { GameView, RoomView } from './types';

type RoomSyncCallbacks = {
  onRoom: (room: RoomView) => void;
  onGame: (game: GameView) => void;
  onConnected?: () => void;
  onError?: (error: unknown) => void;
};

function retryDelay(signal: AbortSignal, milliseconds = 1_000) {
  return new Promise<void>((resolve) => {
    if (signal.aborted) return resolve();
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, milliseconds);
    signal.addEventListener('abort', done, { once: true });
  });
}

/** Keeps a waiting friend room current without fixed-interval polling. */
export function useRoomSync(room: RoomView | null, callbacks: RoomSyncCallbacks) {
  const callbacksRef = useRef(callbacks);
  callbacksRef.current = callbacks;

  useEffect(() => {
    if (!room || room.status !== 'waiting') return;
    const controller = new AbortController();
    const { signal } = controller;

    async function synchronize() {
      let version = room!.version;
      while (!signal.aborted) {
        try {
          const result = await waitForRoom(room!.id, version, signal);
          if (signal.aborted) return;
          callbacksRef.current.onConnected?.();
          version = result.version;
          if (!result.changed) continue;
          if (result.room.status === 'playing' && result.room.gameId) {
            const game = await getGame(result.room.gameId, signal);
            if (!signal.aborted) callbacksRef.current.onGame(game);
            return;
          }
          callbacksRef.current.onRoom(result.room);
          if (result.room.status !== 'waiting') return;
        } catch (error) {
          if (signal.aborted) return;
          callbacksRef.current.onError?.(error);
          if (error instanceof ApiError && [401, 403, 404].includes(error.status)) return;
          await retryDelay(signal);
        }
      }
    }

    void synchronize();
    return () => controller.abort();
  }, [room?.id, room?.status]);
}
