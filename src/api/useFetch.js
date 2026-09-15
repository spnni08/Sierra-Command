import { useEffect, useState, useCallback } from 'react';

// Small shared loading/error/data hook for worker-backed pages.
// `fn` must be stable across renders where possible (wrap with useCallback
// at the call site if it captures changing params).
//
// By default this is a one-shot fetch-on-mount, same as before. Pass
// `{ pollMs }` as a third argument to also refetch on that interval — opt-in
// per call site so a one-time load (e.g. Settings' credential status) isn't
// accidentally turned into a poll loop against a rate-limited upstream.
// Polling re-fetches in the background: it never resets `data` to null or
// flips `loading` back to true, so the UI doesn't flash/blank on every
// tick — only the initial mount does that.
export function useFetch(fn, deps, { pollMs } = {}) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const load = useCallback((opts) => {
    let cancelled = false;
    const isBackground = !!(opts && opts.background);
    if (!isBackground) {
      setLoading(true);
      setError(null);
    }
    fn()
      .then((result) => {
        if (!cancelled) {
          setData(result);
          if (isBackground) setError(null);
        }
      })
      .catch((err) => {
        if (!cancelled) setError(err);
      })
      .finally(() => {
        if (!cancelled && !isBackground) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  useEffect(() => load(), [load]);

  useEffect(() => {
    if (!pollMs) return undefined;
    const id = setInterval(() => load({ background: true }), pollMs);
    return () => clearInterval(id);
  }, [load, pollMs]);

  return { data, loading, error, reload: load };
}
