// Hand-authored by Metrivio — NOT part of the upstream xactions snapshot.
// See VENDOR.md "Hand-authored TypeScript declarations" for why this exists
// and what must be reviewed when the vendor pin is bumped.

export interface TwitterHttpClientOptions {
  /** Cookie string (`name=val; name2=val2`). Omit for guest-token (no-login) mode. */
  cookies?: string;
  proxy?: string;
  rateLimitStrategy?: 'wait' | 'error';
  maxRetries?: number;
  userAgent?: string;
  debug?: boolean;
}

export class TwitterHttpClient {
  constructor(options?: TwitterHttpClientOptions);
  isAuthenticated(): boolean;
  graphql(queryId: string, operationName: string, variables: Record<string, unknown>): Promise<unknown>;
}

export class WaitingRateLimitStrategy {
  onRateLimit(info: { resetAt: number }): Promise<void>;
}

export class ErrorRateLimitStrategy {
  onRateLimit(info: { resetAt: number; endpoint?: string }): Promise<never>;
}
