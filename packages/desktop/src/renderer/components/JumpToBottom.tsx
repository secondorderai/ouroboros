import React from 'react';

interface JumpToBottomProps {
  onClick: () => void;
}

/**
 * Floating button that appears when the user has scrolled up while new
 * messages are arriving. Clicking it scrolls the chat list to the bottom.
 */
export const JumpToBottom: React.FC<JumpToBottomProps> = ({ onClick }) => (
  <button className="jump-to-bottom" onClick={onClick} type="button">
    Jump to bottom
  </button>
);
