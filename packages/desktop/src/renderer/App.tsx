import React from 'react';
import { ChatView } from './views/ChatView';
import { InputBar } from './components/InputBar';
import { useNotifications } from './hooks/useNotifications';

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

const appStyle: React.CSSProperties = {
  display: 'flex',
  height: '100%',
  width: '100%',
  background: 'var(--bg-primary)',
};

/** Placeholder sidebar (250px). Ticket 02 builds the real one. */
const sidebarStyle: React.CSSProperties = {
  width: 250,
  flexShrink: 0,
  background: 'var(--bg-sidebar)',
  borderRight: '1px solid var(--border-light)',
};

const mainStyle: React.CSSProperties = {
  flex: 1,
  display: 'flex',
  flexDirection: 'column',
  minWidth: 0,
};

// ---------------------------------------------------------------------------
// App
// ---------------------------------------------------------------------------

const App: React.FC = () => {
  // Subscribe to CLI notifications and dispatch to the conversation store.
  useNotifications();

  return (
    <div style={appStyle}>
      {/* Sidebar placeholder */}
      <div style={sidebarStyle} />

      {/* Main content: chat + input */}
      <div style={mainStyle}>
        <ChatView />
        <InputBar />
      </div>
    </div>
  );
};

export default App;
