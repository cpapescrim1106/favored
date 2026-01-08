import { ProtectedPaths } from "@/constants/paths";

export function isRoute(pathname: string, path: string) {
  if (!pathname.startsWith("/")) pathname = "/" + pathname;
  return pathname.startsWith(path);
}

export function isProtectedRoute(pathname: string) {
  if (!pathname.startsWith("/")) pathname = "/" + pathname;
  return ProtectedPaths.some((protectedPath) => {
    const regex = new RegExp(`^${protectedPath}$`);
    return regex.test(pathname);
  });
}
