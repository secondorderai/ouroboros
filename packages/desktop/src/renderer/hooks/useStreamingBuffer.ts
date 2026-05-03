import { useEffect, useRef, useState } from 'react';
import { useConversationStore } from '../stores/conversationStore';

/**
 * ~60 fps cap on how often we re-render the streaming buffer. Real LLMs can
 * push 50+ `agent/text` chunks per second, and we don't want each one to
 * trigger a React re-render of the (potentially large) markdown body. This is
 * picked deliberately as a `setTimeout` interval rather than `requestAnimationFrame`:
 * Electron windows that aren't displayed (E2E tests run with
 * `OUROBOROS_TEST_HIDE_WINDOW=1`, and Chromium on Linux/xvfb in particular
 * throttles rAF in unmapped windows even with `backgroundThrottling: false`)
 * effectively pause rAF, which previously stalled `streamingText` rendering
 * and made every "expect streamed text visible" assertion in the E2E suite
 * fail with "element not found" on CI.
 */
const FLUSH_INTERVAL_MS = 16;

/**
 * Buffers incoming streaming text and flushes to a local state variable at
 * most once per FLUSH_INTERVAL_MS. This prevents React from re-rendering on
 * every individual `agent/text` chunk and instead batches updates to ~60fps.
 *
 * Returns the buffered text that is safe to render.
 */
export function useStreamingBuffer(): string | null {
  const streamingText = useConversationStore((s) => s.streamingText);
  const [buffered, setBuffered] = useState<string | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const latestRef = useRef<string | null>(null);

  useEffect(() => {
    latestRef.current = streamingText;

    // If streaming has ended (null), flush immediately.
    if (streamingText === null) {
      if (timerRef.current !== null) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
      setBuffered(null);
      return;
    }

    // Schedule a flush if one isn't already pending.
    if (timerRef.current === null) {
      timerRef.current = setTimeout(() => {
        timerRef.current = null;
        setBuffered(latestRef.current);
      }, FLUSH_INTERVAL_MS);
    }
  }, [streamingText]);

  // Clean up on unmount.
  useEffect(() => {
    return () => {
      if (timerRef.current !== null) {
        clearTimeout(timerRef.current);
      }
    };
  }, []);

  // Short-circuit: when the store has cleared streamingText (turn-complete /
  // cancel), hide the buffer immediately even though setBuffered(null) only
  // applies on the next render. Otherwise the completed agent message and
  // the streaming row briefly render the same final text twice.
  return streamingText === null ? null : buffered;
}
