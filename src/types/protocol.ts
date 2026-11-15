/**
 * Music Assistant WebSocket message types
 */

export interface MAMessage {
  message_id: number;
  command?: string;
  args?: Record<string, unknown>;
  result?: unknown;
  error?: MAError;
  event?: string;
  data?: unknown;
}

export interface MAError {
  code: string;
  message: string;
}
