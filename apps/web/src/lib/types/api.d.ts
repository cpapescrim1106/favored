import type { Session } from "next-auth";
import type { NextRequest } from "next/server";

export type ApiResponse<T> = {
  message?: string
  error?: string
} & T;

export type SortOrder = "desc" | "asc";

/**
 * AppRouteHandlerFnContext is the context that is passed to the handler as the
 * second argument.
 */
export interface AppRouteHandlerFnContext {
  params?: Promise<Record<string, string | string[]>>
}

export interface NextAuthRequest extends NextRequest {
  auth: Session | null
}
