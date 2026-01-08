/**
 * Database utilities
 *
 * Note: Prisma client should be created in each app using the generated client.
 * This file exports shared utilities for database operations.
 */

// Re-export types that might be useful
export type LogLevel = "INFO" | "WARN" | "ERROR";
export type LogCategory =
  | "SCAN"
  | "BASKET"
  | "ORDER"
  | "RECONCILE"
  | "EXIT"
  | "SYSTEM";
