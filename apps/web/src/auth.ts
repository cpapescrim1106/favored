import type { Role } from "@/generated/prisma/client";

export type Session = {
  user: {
    role: Role;
  };
};

type AuthHandler = (
  request: { auth?: Session | null },
  context?: unknown
) => Promise<unknown>;

export function auth(): Promise<Session | null>;
export function auth<
  TRequest extends { auth?: Session | null },
  TContext = unknown,
>(
  handler: (request: TRequest, context?: TContext) => Promise<unknown>
): (request: TRequest, context?: TContext) => Promise<unknown>;
export function auth(handler?: AuthHandler): Promise<Session | null> | AuthHandler {
  if (!handler) {
    return Promise.resolve(null);
  }

  return async (request: { auth?: Session | null }, context?: unknown) => {
    request.auth = null;
    return handler(request, context);
  };
}
