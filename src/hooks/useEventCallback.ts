import { useCallback, useLayoutEffect, useRef } from "react";

/** Stable event identity with the latest committed state; never call during render. */
export function useEventCallback<Args extends unknown[], Result>(callback: (...args: Args) => Result): (...args: Args) => Result {
  const ref = useRef(callback);
  useLayoutEffect(() => { ref.current = callback; });
  return useCallback((...args: Args) => ref.current(...args), []);
}
