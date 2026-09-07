// Hand-authored by Metrivio — NOT part of the upstream x-manager snapshot.
// See VENDOR.md "Hand-authored TypeScript declarations" for why this exists.

export interface PostTweetApiError {
  message: string;
  type?: string;
}

export interface PostTweetApiResponse {
  httpStatus?: number;
  data?: {
    id: string;
    text: string;
  };
  errors?: PostTweetApiError[];
}

export function postTweetHttp(baseUrl: string, authorizationHeader: string, text: string): Promise<PostTweetApiResponse>;

export function normalizeErrorResponse(response: Response, payload: unknown): PostTweetApiResponse;

export function asRecord(value: unknown): Record<string, unknown> | null;

export function asString(value: unknown): string | null;

export function uniqueMessages(messages: string[]): string[];
