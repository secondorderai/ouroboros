import React from 'react';

/**
 * Blinking cursor that appears at the end of streaming agent text.
 * Uses the `.streaming-cursor` class defined in global.css.
 */
export const StreamingCursor: React.FC = () => (
  <span className="streaming-cursor" aria-hidden="true" />
);
