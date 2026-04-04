/**
 * Single-Shot Mode
 *
 * Processes one prompt, outputs the result, and exits.
 * Used for piped input (`echo "hello" | ouroboros`) and inline prompts (`ouroboros -m "prompt"`).
 * Writes directly to stdout — bypasses any rich UI for piping compatibility.
 */

import type { AgentEvent } from '@src/agent'
import { Renderer } from './renderer'

/**
 * Create an event handler for single-shot mode.
 *
 * The returned handler is wired into the Agent via a mutable dispatch proxy
 * in cli.ts. It renders streaming text, tool call indicators, and errors
 * to stdout/stderr.
 *
 * When `noStream` is true, text is accumulated and written all at once
 * when the turn completes (useful for piped/scripted usage).
 */
export function createSingleShotHandler(options: { verbose: boolean; noStream: boolean }): {
  handler: (event: AgentEvent) => void
  getAccumulatedText: () => string
} {
  const renderer = new Renderer({
    verbose: options.verbose,
    isTTY: process.stdout.isTTY === true
  })

  let accumulatedText = ''

  const handler = (event: AgentEvent): void => {
    switch (event.type) {
      case 'text':
        if (options.noStream) {
          accumulatedText += event.text
        } else {
          renderer.writeText(event.text)
        }
        break

      case 'tool-call-start':
        renderer.startToolCall(event.toolCallId, event.toolName, event.args)
        break

      case 'tool-call-end':
        renderer.endToolCall(event.toolCallId, event.toolName, event.result, event.isError)
        break

      case 'error':
        renderer.writeError(event.error)
        break

      case 'turn-complete':
        if (options.noStream) {
          renderer.writeText(accumulatedText)
        }
        break
    }
  }

  return { handler, getAccumulatedText: () => accumulatedText }
}
