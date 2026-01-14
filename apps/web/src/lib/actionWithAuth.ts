import { auth } from "@/auth";
import type { Role } from "@/generated/prisma/client";
import type { Session } from "@/auth";
import type { ActionReturn } from "./types/action";

export function actionWithAuth<
  TArgs extends unknown[],
  TReturn extends ActionReturn<unknown>,
>(
  options: {
    roles?: Role | Role[];
    authorize?: (
      session: Session,
      ...args: TArgs
    ) => boolean | Promise<boolean>;
    onUnauthorized?: (...args: TArgs) => Promise<TReturn>;
    onForbidden?: (...args: TArgs) => Promise<TReturn>;
    onError?: (...args: TArgs) => Promise<TReturn>;
  },
  handler: (session: Session, ...args: TArgs) => Promise<TReturn>,
) {
  return async (...args: TArgs) => {
    try {
      const session = await auth();

      // check authorize
      if (!session || !session?.user?.role)
        return options.onUnauthorized
          ? await options.onUnauthorized(...args)
          : {
              ok: false,
              errors: "Unauthorized",
            };

      // Check roles if specified
      if (options.roles) {
        const roleList = Array.isArray(options.roles)
          ? options.roles
          : [options.roles];
        if (!roleList.includes(session.user.role)) {
          return options.onForbidden
            ? await options.onForbidden(...args)
            : {
                ok: false,
                errors: "Forbidden",
              };
        }
      }

      // Check custom authorization if specified
      if (options.authorize) {
        const isAuthorized = await options.authorize(session, ...args);
        if (!isAuthorized) {
          return options.onForbidden
            ? await options.onForbidden(...args)
            : {
                ok: false,
                errors: "Forbidden",
              };
        }
      }

      return handler(session, ...args);
    } catch (error) {
      console.error("actionWithAuth error:", error);
      if (options.onError) return options.onError(...args);
      return {
        ok: false,
        errors: "Internal server error",
      };
    }
  };
}

export default actionWithAuth;
