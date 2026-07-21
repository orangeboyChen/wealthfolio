/**
 * Wealthfolio Connect runtime configuration.
 *
 * Instead of relying on compile-time environment variables (import.meta.env),
 * the frontend fetches connect configuration from the backend at runtime.
 * This allows changing CONNECT_AUTH_URL, CONNECT_AUTH_PUBLISHABLE_KEY, etc.
 * via Docker environment variables without rebuilding the frontend.
 */

import { useQuery } from "@tanstack/react-query";
import { invoke } from "#platform";

export interface ConnectConfig {
  enabled: boolean;
  authUrl: string | null;
  authPublishableKey: string | null;
  apiUrl: string | null;
  oauthCallbackUrl: string | null;
}

/**
 * Hook to fetch connect configuration from the backend.
 * The config is fetched once and cached indefinitely (staleTime: Infinity)
 * since these values don't change during a session.
 */
export function useConnectConfig() {
  return useQuery<ConnectConfig>({
    queryKey: ["connect-config"],
    queryFn: () => invoke<ConnectConfig>("get_connect_config", {}),
    staleTime: Infinity,
    refetchOnWindowFocus: false,
    refetchOnMount: false,
    retry: 2,
  });
}

/**
 * Legacy static check — kept as a fast synchronous fallback for contexts
 * that cannot use hooks (e.g. top-level route guards).
 * Prefer useConnectConfig() wherever possible.
 */
export const CONNECT_ENABLED = Boolean(
  import.meta.env.CONNECT_AUTH_URL && import.meta.env.CONNECT_AUTH_PUBLISHABLE_KEY,
);
