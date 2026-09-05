// Hand-authored by Metrivio — NOT part of the upstream xactions snapshot.
// See VENDOR.md "Hand-authored TypeScript declarations" for why this exists
// and what must be reviewed when the vendor pin is bumped.

export interface TwitterApiErrorOptions {
  status?: number;
  data?: unknown;
  endpoint?: string;
}

export class TwitterApiError extends Error {
  status?: number;
  data?: unknown;
  endpoint?: string;
  constructor(message: string, options?: TwitterApiErrorOptions);
}

export class RateLimitError extends TwitterApiError {
  resetAt?: number;
  limit?: number;
  remaining?: number;
  constructor(message: string, options?: TwitterApiErrorOptions & { resetAt?: number; limit?: number; remaining?: number });
}

export class AuthError extends TwitterApiError {}
export class NotFoundError extends TwitterApiError {}
export class NetworkError extends TwitterApiError {}

export function parseTwitterErrors(
  response: unknown,
  status: number,
  endpoint?: string
): { handled: boolean; result?: { success: boolean } };
