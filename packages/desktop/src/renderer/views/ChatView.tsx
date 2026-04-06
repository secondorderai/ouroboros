import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Virtuoso as VirtuosoOrig, type VirtuosoHandle } from 'react-virtuoso';
import { useConversationStore } from '../stores/conversationStore';
import { useStreamingBuffer } from '../hooks/useStreamingBuffer';
import { UserMessage } from '../components/UserMessage';
import { AgentMessage, StreamingAgentMessage } from '../components/AgentMessage';
import { SystemMessage } from '../components/SystemMessage';
import { JumpToBottom } from '../components/JumpToBottom';
import type { Message } from '../../shared/protocol';

// Work around @types/react version mismatch between root (v19, from ink) and
// desktop package (v18). The cast is safe — the runtime component is identical.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const Virtuoso = VirtuosoOrig as any;

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

const chatAreaStyle: React.CSSProperties = {
  flex: 1,
  position: 'relative',
  display: 'flex',
  flexDirection: 'column',
  overflow: 'hidden',
  background: 'var(--bg-chat)',
};

const listContainerStyle: React.CSSProperties = {
  flex: 1,
  overflow: 'hidden',
};

// ---------------------------------------------------------------------------
// Message renderer
// ---------------------------------------------------------------------------

const MessageItem: React.FC<{ message: Message }> = ({ message }) => {
  switch (message.role) {
    case 'user':
      return <UserMessage message={message} />;
    case 'agent':
      return <AgentMessage message={message} />;
    case 'system':
    case 'error':
      return <SystemMessage message={message} />;
    default:
      return null;
  }
};

// ---------------------------------------------------------------------------
// ChatView
// ---------------------------------------------------------------------------

/**
 * The primary chat view. Renders the message list with virtual scrolling,
 * the streaming agent message, and the "jump to bottom" button.
 */
export const ChatView: React.FC = () => {
  const messages = useConversationStore((s) => s.messages);
  const isAgentRunning = useConversationStore((s) => s.isAgentRunning);
  const activeToolCalls = useConversationStore((s) => s.activeToolCalls);
  const bufferedText = useStreamingBuffer();

  const virtuosoRef = useRef<VirtuosoHandle>(null);
  const [atBottom, setAtBottom] = useState(true);
  const [showJump, setShowJump] = useState(false);

  // Determine whether the streaming row is visible. We append it as an
  // extra item at the end of the list whenever the agent is running and
  // there is buffered text to show.
  const isStreaming = isAgentRunning && bufferedText !== null;

  // Total item count = completed messages + optional streaming row.
  const totalCount = messages.length + (isStreaming ? 1 : 0);

  // Show "jump to bottom" when user has scrolled up AND there's new content.
  useEffect(() => {
    if (!atBottom && (isStreaming || messages.length > 0)) {
      setShowJump(true);
    } else {
      setShowJump(false);
    }
  }, [atBottom, isStreaming, messages.length]);

  const jumpToBottom = useCallback(() => {
    virtuosoRef.current?.scrollToIndex({
      index: totalCount - 1,
      align: 'end',
      behavior: 'smooth',
    });
  }, [totalCount]);

  const handleAtBottomChange = useCallback((bottom: boolean) => {
    setAtBottom(bottom);
  }, []);

  // Render a single item by index.
  const renderItem = useCallback(
    (index: number) => {
      // If the index falls within completed messages, render the message.
      if (index < messages.length) {
        return <MessageItem message={messages[index]} />;
      }

      // Otherwise this is the streaming row.
      return (
        <StreamingAgentMessage
          text={bufferedText ?? ''}
          activeToolCalls={activeToolCalls}
        />
      );
    },
    [messages, bufferedText, activeToolCalls],
  );

  return (
    <div style={chatAreaStyle}>
      <div style={listContainerStyle}>
        <Virtuoso
          ref={virtuosoRef}
          totalCount={totalCount}
          itemContent={renderItem}
          followOutput="smooth"
          atBottomStateChange={handleAtBottomChange}
          atBottomThreshold={60}
          style={{ height: '100%' }}
          components={{
            Item: ({ children, ...props }: { children: React.ReactNode; [key: string]: unknown }) => (
              <div {...props} style={{ paddingBottom: 16 }}>
                {children}
              </div>
            ),
          }}
        />
      </div>

      {showJump && <JumpToBottom onClick={jumpToBottom} />}
    </div>
  );
};
