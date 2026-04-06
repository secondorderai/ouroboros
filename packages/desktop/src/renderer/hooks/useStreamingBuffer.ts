import { useEffect, useRef, useState } from 'react';
import { useConversationStore } from '../stores/conversationStore';

/**
 * Buffers incoming streaming text and flushes to a local state variable at
 * most once per animation frame (via requestAnimationFrame). This prevents
 * React from re-rendering on every individual `agent/text` chunk — which
 * can arrive 50+ times per second — and instead batches updates to ~60fps.
 *
 * Returns the buffered text that is safe to render.
 */
export function useStreamingBuffer(): string | null {
  const streamingText = useConversationStore((s) => s.streamingText);
  const [buffered, setBuffered] = useState<string | null>(null);
  const rafRef = useRef<number | null>(null);
  const latestRef = useRef<string | null>(null);

  useEffect(() => {
    latestRef.current = streamingText;

    // If streaming has ended (null), flush immediately.
    if (streamingText === null) {
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
      setBuffered(null);
      return;
    }

    // Schedule a flush if one isn't already pending.
    if (rafRef.current === null) {
      rafRef.current = requestAnimationFrame(() => {
        rafRef.current = null;
        setBuffered(latestRef.current);
      });
    }
  }, [streamingText]);

  // Clean up on unmount.
  useEffect(() => {
    return () => {
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current);
      }
    };
  }, []);

  return buffered;
}
