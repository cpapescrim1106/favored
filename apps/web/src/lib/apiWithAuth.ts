import { auth } from "@/auth";
import type { Role } from "@/generated/prisma/client";
import {
  forbidden,
  internalServerError,
  unauthorized,
} from "@/lib/apiResponse";
import type {
  AppRouteHandlerFnContext,
  NextAuthRequest,
} from "@/lib/types/api";
import type { Session } from "@/auth";
import type { NextResponse } from "next/server";

export type AuthorizeCallback = (
  user: Session["user"],
  request: NextAuthRequest,
  context: AppRouteHandlerFnContext,
) => boolean | Promise<boolean>;
export type UnauthorizedCallback = (
  request: NextAuthRequest,
) => NextResponse | Promise<NextResponse>;
export type ForbiddenCallback = (
  request: NextAuthRequest,
) => NextResponse | Promise<NextResponse>;

interface ApiWithAuthOptions {
  roles?: Role | Role[];
  authorize?: AuthorizeCallback;
  onUnauthorized?: UnauthorizedCallback;
  onForbidden?: ForbiddenCallback;
}

function apiWithAuth(
  options: ApiWithAuthOptions,
  handler: (
    request: NextAuthRequest,
    context: AppRouteHandlerFnContext,
  ) => Promise<NextResponse>,
) {
  return auth(async (request: NextAuthRequest, context) => {
    try {
      if (!request.auth) {
        return options.onUnauthorized
          ? await options.onUnauthorized(request as NextAuthRequest)
          : unauthorized();
      }

      // Check roles if specified
      if (options.roles) {
        const roleList = Array.isArray(options.roles)
          ? options.roles
          : [options.roles];
        if (!roleList.includes(request.auth.user.role)) {
          return options.onForbidden
            ? await options.onForbidden(request as NextAuthRequest)
            : forbidden();
        }
      }

      // Check custom authorization if specified
      if (options.authorize) {
        const isAuthorized = await options.authorize(
          request.auth.user,
          request,
          context as AppRouteHandlerFnContext,
        );
        if (!isAuthorized) {
          return options.onForbidden
            ? await options.onForbidden(request as NextAuthRequest)
            : forbidden();
        }
      }

      // If all checks pass, call the handler
      return handler(request, context as AppRouteHandlerFnContext);
    } catch (error) {
      console.error("Auth middleware error:", error);
      return internalServerError();
    }
  });
}

export default apiWithAuth;
