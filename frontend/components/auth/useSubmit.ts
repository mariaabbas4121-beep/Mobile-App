import { useCallback, useEffect, useRef, useState } from 'react';

// Runs an async action at most once at a time. The ref blocks a second tap
// that arrives before React has re-rendered with `busy = true`.
export function useSubmit<A extends unknown[]>(action: (...args: A) => Promise<void>) {
  const running = useRef(false);
  const mounted = useRef(true);
  const [busy, setBusy] = useState(false);

  // Set on every mount: React may unmount and remount the same instance
  // (Strict Mode), and a stale `false` would leave `busy` stuck on.
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const run = useCallback(
    async (...args: A) => {
      if (running.current) return;
      running.current = true;
      setBusy(true);
      try {
        await action(...args);
      } finally {
        running.current = false;
        if (mounted.current) setBusy(false);
      }
    },
    [action],
  );

  return [run, busy] as const;
}
