/**
 * Ensures a function is only called in client components
 * @throws Error if called in a server component
 */
export function ensureClient(functionName = "This function") {
  if (typeof window === "undefined") {
    throw new Error(
      `${functionName} cannot be called in server components. Please use this function only in client components.`,
    );
  }
}

/**
 * Ensures a function is only called in server components
 * @throws Error if called in a client component
 */
export function ensureServer(functionName = "This function") {
  if (typeof window !== "undefined") {
    throw new Error(
      `${functionName} cannot be called in client components. Please use server-side data fetching methods instead.`,
    );
  }
}
