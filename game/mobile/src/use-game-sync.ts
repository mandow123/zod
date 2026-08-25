import { useEffect, useRef } from 'react';
import { ApiError, waitForGame } from './api';
import type { GameView } from './types';

type GameSyncCallbacks = {
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

/** Receives immediate game changes and refreshes at most every five seconds for server timeout enforcement. */
export function useGameSync(game: GameView | null, callbacks: GameSyncCallbacks) {
  const callbacksRef = useRef(callbacks);
  callbacksRef.current = callbacks;

  useEffect(() => {
    if (!game || game.phase === 'finished') return;
    const controller = new AbortController();
    const { signal } = controller;

    async function synchronize() {
      let version = game!.sequence;
      while (!signal.aborted) {
        try {
          const result = await waitForGame(game!.id, version, signal, 5_000);
          if (signal.aborted) return;
          callbacksRef.current.onConnected?.();
          version = result.version;
          if (!result.changed) continue;
          callbacksRef.current.onGame(result.game);
          if (result.game.phase === 'finished') return;
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
  }, [game?.id, game?.phase]);
}
