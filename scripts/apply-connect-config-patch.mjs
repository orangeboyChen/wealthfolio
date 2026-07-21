#!/usr/bin/env node

import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const rootDir = process.cwd();

function filePath(relativePath) {
  return resolve(rootDir, relativePath);
}

function readText(relativePath) {
  return readFileSync(filePath(relativePath), "utf8");
}

function writeText(relativePath, content) {
  writeFileSync(filePath(relativePath), content);
}

function replaceOnce(content, from, to, label) {
  if (content.includes(to)) {
    return content;
  }

  const next = content.replace(from, to);
  if (next === content) {
    throw new Error(`Unable to update ${label}`);
  }

  return next;
}

function insertAfter(content, anchor, insert, label) {
  if (content.includes(insert)) {
    return content;
  }

  const index = content.indexOf(anchor);
  if (index === -1) {
    throw new Error(`Unable to find anchor for ${label}`);
  }

  return content.slice(0, index + anchor.length) + insert + content.slice(index + anchor.length);
}

function insertAfterAny(content, anchors, insert, label) {
  if (content.includes(insert)) {
    return content;
  }

  for (const anchor of anchors) {
    const index = content.indexOf(anchor);
    if (index !== -1) {
      return content.slice(0, index + anchor.length) + insert + content.slice(index + anchor.length);
    }
  }

  throw new Error(`Unable to find anchor for ${label}`);
}

function insertBefore(content, anchor, insert, label) {
  if (content.includes(insert)) {
    return content;
  }

  const index = content.indexOf(anchor);
  if (index === -1) {
    throw new Error(`Unable to find anchor for ${label}`);
  }

  return content.slice(0, index) + insert + content.slice(index);
}

function updateBackend() {
  let content = readText("apps/server/src/api/connect.rs");

  content = insertBefore(
    content,
    "/// Create a ConnectApiClient with a fresh access token\n",
    `// --- Connect Config endpoint (public, no auth required) ---

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectConfigResponse {
    pub enabled: bool,
    pub auth_url: Option<String>,
    pub auth_publishable_key: Option<String>,
    pub api_url: Option<String>,
    pub oauth_callback_url: Option<String>,
}

async fn get_connect_config() -> Json<ConnectConfigResponse> {
    let auth_url = connect_auth_url();
    let publishable_key = connect_auth_api_key();
    let api_url = crate::features::cloud_api_base_url();
    let oauth_callback_url = std::env::var("CONNECT_OAUTH_CALLBACK_URL")
        .ok()
        .map(|v| v.trim().trim_end_matches('/').to_string())
        .filter(|v| !v.is_empty())
        .or_else(|| option_env!("CONNECT_OAUTH_CALLBACK_URL").map(|v| v.trim_end_matches('/').to_string()));

    let enabled = auth_url.is_some()
        && publishable_key.is_some()
        && crate::features::cloud_sync_enabled();

    Json(ConnectConfigResponse {
        enabled,
        auth_url,
        auth_publishable_key: publishable_key,
        api_url,
        oauth_callback_url,
    })
}

`,
    "backend connect config block",
  );

  content = insertAfterAny(
    content,
    ["    let router = Router::new()\n", "    Router::new()\n"],
    `        // Connect config (public, no auth required)
        .route("/connect/config", get(get_connect_config))
`,
    "backend connect config route",
  );

  writeText("apps/server/src/api/connect.rs", content);
}

function updateFrontendCore() {
  let content = readText("apps/frontend/src/adapters/web/core.ts");
  content = insertAfter(
    content,
    "  // Wealthfolio Connect (Broker Sync)\n",
    `  get_connect_config: { method: "GET", path: "/connect/config" },
`,
    "frontend connect command",
  );
  writeText("apps/frontend/src/adapters/web/core.ts", content);
}

function updateConnectionStatus() {
  const connectedCheck = 'connection.status === "connected" && !connection.disabled';
  const selfHostedConnectedCheck =
    '(connection.status === "connected" || connection.status === "active") && !connection.disabled';

  for (const relativePath of [
    "apps/frontend/src/features/wealthfolio-connect/pages/connect-page.tsx",
    "apps/frontend/src/features/wealthfolio-connect/components/connected-view.tsx",
  ]) {
    let content = readText(relativePath);
    content = replaceOnce(
      content,
      connectedCheck,
      selfHostedConnectedCheck,
      `self-hosted connection status in ${relativePath}`,
    );
    writeText(relativePath, content);
  }

  let content = readText("crates/connect/src/post_login_bootstrap.rs");
  content = replaceOnce(
    content,
    'status.eq_ignore_ascii_case("connected")',
    'status.eq_ignore_ascii_case("connected") || status.eq_ignore_ascii_case("active")',
    "post-login self-hosted connection status",
  );
  writeText("crates/connect/src/post_login_bootstrap.rs", content);
}

function updateServerCsp() {
  let content = readText("apps/server/src/api.rs");
  content = replaceOnce(
    content,
    "https://connect-staging.wealthfolio.app;",
    "https://connect-staging.wealthfolio.app https://wealthfolio-connect.home.nowcent.cn:54443;",
    "self-hosted Connect CSP origin",
  );
  writeText("apps/server/src/api.rs", content);
}

function updateFrontendConnectConfig() {
  const content = `/**
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
`;

  writeText("apps/frontend/src/lib/connect-config.ts", content);
}

function updateFrontendProvider() {
  let content = readText("apps/frontend/src/features/wealthfolio-connect/providers/wealthfolio-connect-provider.tsx");

  content = replaceOnce(
    content,
    'import { CONNECT_ENABLED } from "@/lib/connect-config";',
    'import { useConnectConfig, type ConnectConfig } from "@/lib/connect-config";',
    "connect config import",
  );

  content = replaceOnce(
    content,
    `// Auth configuration - these are public/publishable keys (safe for client-side)
// Can be overridden via environment variables: CONNECT_AUTH_URL and CONNECT_AUTH_PUBLISHABLE_KEY
const AUTH_URL = (import.meta.env.CONNECT_AUTH_URL as string) || "https://auth.wealthfolio.app";
const AUTH_PUBLISHABLE_KEY =
  (import.meta.env.CONNECT_AUTH_PUBLISHABLE_KEY as string) ||
  "sb_publishable_ZSZbXNtWtnh9i2nqJ2UL4A_NV8ZVutd";
`,
    `// Auth configuration defaults - used only when backend config is unavailable
const DEFAULT_AUTH_URL = "https://auth.wealthfolio.app";
const DEFAULT_AUTH_PUBLISHABLE_KEY = "sb_publishable_ZSZbXNtWtnh9i2nqJ2UL4A_NV8ZVutd";
`,
    "auth defaults",
  );

  content = replaceOnce(
    content,
    `// For OAuth on desktop, we use a hosted callback page that redirects to the deep link
// This is necessary because browsers block direct navigation to custom URL schemes
// Uses env variable in dev, falls back to production URL for bundled builds
const HOSTED_OAUTH_CALLBACK_URL =
  (import.meta.env.CONNECT_OAUTH_CALLBACK_URL as string) ||
  "https://connect.wealthfolio.app/deeplink";
`,
    `// Default OAuth callback URL - can be overridden via backend config
const DEFAULT_OAUTH_CALLBACK_URL = "https://connect.wealthfolio.app/deeplink";
`,
    "oauth callback default",
  );

  const legacyAuthCallbackParser = `const parseConfiguredAuthCallbackUrl = (url: string) =>
  parseAuthCallbackUrl(url, { hostedCallbackUrl: HOSTED_OAUTH_CALLBACK_URL });
`;
  const updatedAuthCallbackParser = `const parseConfiguredAuthCallbackUrl = (url: string) =>
  parseAuthCallbackUrl(url, { hostedCallbackUrl: DEFAULT_OAUTH_CALLBACK_URL });
`;

  if (content.includes(legacyAuthCallbackParser)) {
    content = replaceOnce(
      content,
      legacyAuthCallbackParser,
      updatedAuthCallbackParser,
      "auth callback parser",
    );
  } else if (!content.includes(updatedAuthCallbackParser)) {
    content = insertAfter(
      content,
      `const DEFAULT_OAUTH_CALLBACK_URL = "https://connect.wealthfolio.app/deeplink";
`,
      `
const parseConfiguredAuthCallbackUrl = (url: string) =>
  parseAuthCallbackUrl(url, { hostedCallbackUrl: DEFAULT_OAUTH_CALLBACK_URL });
`,
      "auth callback parser",
    );

    content = replaceOnce(
      content,
      `const payload = parseAuthCallbackUrl(url);`,
      `const payload = parseConfiguredAuthCallbackUrl(url);`,
      "auth callback payload",
    );

    content = replaceOnce(
      content,
      `const authPayload = parseAuthCallbackUrl(url);`,
      `const authPayload = parseConfiguredAuthCallbackUrl(url);`,
      "auth callback deep link",
    );

    content = replaceOnce(
      content,
      `if (parseAuthCallbackUrl(currentUrl)) {`,
      `if (parseConfiguredAuthCallbackUrl(currentUrl)) {`,
      "auth callback url check",
    );
  }

  content = replaceOnce(
    content,
    `const createSupabaseClient = () => {
  const storageKey = getAuthStorageKey(AUTH_URL);
  return createClient(AUTH_URL, AUTH_PUBLISHABLE_KEY, {
`,
    `const createSupabaseClient = (authUrl: string, publishableKey: string) => {
  const storageKey = getAuthStorageKey(authUrl);
  return createClient(authUrl, publishableKey, {
`,
    "supabase client factory",
  );

  content = replaceOnce(
    content,
    `function EnabledWealthfolioConnectProvider({ children }: { children: ReactNode }) {
`,
    `function EnabledWealthfolioConnectProvider({
  children,
  config,
}: {
  children: ReactNode;
  config: ConnectConfig;
}) {
  const authUrl = config.authUrl || DEFAULT_AUTH_URL;
  const publishableKey = config.authPublishableKey || DEFAULT_AUTH_PUBLISHABLE_KEY;
  const oauthCallbackUrl = config.oauthCallbackUrl || DEFAULT_OAUTH_CALLBACK_URL;
`,
    "enabled provider signature",
  );

  content = replaceOnce(
    content,
    `  // Initialize Supabase client
  supabaseRef.current ??= createSupabaseClient();
`,
    `  // Initialize Supabase client with runtime config
  supabaseRef.current ??= createSupabaseClient(authUrl, publishableKey);
`,
    "enabled provider client init",
  );

  content = replaceOnce(
    content,
    `            ? HOSTED_OAUTH_CALLBACK_URL // Desktop & Android: bounce page → wealthfolio://
`,
    `            ? oauthCallbackUrl // Desktop & Android: bounce page → wealthfolio://
`,
    "oauth redirect desktop",
  );

  content = replaceOnce(
    content,
    `              ? HOSTED_OAUTH_CALLBACK_URL // Mobile: bounce page → wealthfolio://
`,
    `              ? oauthCallbackUrl // Mobile: bounce page → wealthfolio://
`,
    "oauth redirect mobile",
  );

  content = replaceOnce(
    content,
    `export function WealthfolioConnectProvider({ children }: { children: ReactNode }) {
  const [isCapabilityCheckComplete, setIsCapabilityCheckComplete] = useState(!CONNECT_ENABLED);
  const [isCloudSyncAvailable, setIsCloudSyncAvailable] = useState(false);

  useEffect(() => {
    if (!CONNECT_ENABLED) return;

    let cancelled = false;

    void getPlatform()
      .then((platform) => {
        if (cancelled) return;
        setIsCloudSyncAvailable(
          platform.capabilities?.cloud_sync ?? platform.capabilities?.connect_sync ?? true,
        );
      })
      .catch(() => {
        // Fall back to enabled on detection errors to preserve current behavior.
        if (cancelled) return;
        setIsCloudSyncAvailable(true);
      })
      .finally(() => {
        if (cancelled) return;
        setIsCapabilityCheckComplete(true);
      });

    return () => {
      cancelled = true;
    };
  }, []);

  if (!isCapabilityCheckComplete) {
    return (
      <WealthfolioConnectContext.Provider
        value={{
          ...disabledContextValue,
          isEnabled: true,
          isInitializing: true,
        }}
      >
        {children}
      </WealthfolioConnectContext.Provider>
    );
  }

  if (!CONNECT_ENABLED || !isCloudSyncAvailable) {
    return (
      <WealthfolioConnectContext.Provider value={disabledContextValue}>
        {children}
      </WealthfolioConnectContext.Provider>
    );
  }

  return <EnabledWealthfolioConnectProvider>{children}</EnabledWealthfolioConnectProvider>;
}
`,
    `export function WealthfolioConnectProvider({ children }: { children: ReactNode }) {
  const { data: connectConfig, isLoading: isConfigLoading } = useConnectConfig();
  const [isCapabilityCheckComplete, setIsCapabilityCheckComplete] = useState(false);
  const [isCloudSyncAvailable, setIsCloudSyncAvailable] = useState(false);

  const isConnectEnabled = connectConfig?.enabled ?? false;

  useEffect(() => {
    if (isConfigLoading) return;
    if (!isConnectEnabled) {
      setIsCapabilityCheckComplete(true);
      return;
    }

    let cancelled = false;

    void getPlatform()
      .then((platform) => {
        if (cancelled) return;
        setIsCloudSyncAvailable(
          platform.capabilities?.cloud_sync ?? platform.capabilities?.connect_sync ?? true,
        );
      })
      .catch(() => {
        // Fall back to enabled on detection errors to preserve current behavior.
        if (cancelled) return;
        setIsCloudSyncAvailable(true);
      })
      .finally(() => {
        if (cancelled) return;
        setIsCapabilityCheckComplete(true);
      });

    return () => {
      cancelled = true;
    };
  }, [isConfigLoading, isConnectEnabled]);

  if (isConfigLoading || !isCapabilityCheckComplete) {
    return (
      <WealthfolioConnectContext.Provider
        value={{
          ...disabledContextValue,
          isEnabled: isConnectEnabled,
          isInitializing: true,
        }}
      >
        {children}
      </WealthfolioConnectContext.Provider>
    );
  }

  if (!isConnectEnabled || !isCloudSyncAvailable) {
    return (
      <WealthfolioConnectContext.Provider value={disabledContextValue}>
        {children}
      </WealthfolioConnectContext.Provider>
    );
  }

  return (
    <EnabledWealthfolioConnectProvider config={connectConfig!}>
      {children}
    </EnabledWealthfolioConnectProvider>
  );
}
`,
    "main provider",
  );

  writeText("apps/frontend/src/features/wealthfolio-connect/providers/wealthfolio-connect-provider.tsx", content);
}

function updateTauri() {
  let content = readText("apps/tauri/src/commands/wealthfolio_connect.rs");

  content = replaceOnce(
    content,
    "use crate::secret_store::KeyringSecretStore;\n",
    "use crate::secret_store::KeyringSecretStore;\nuse crate::services::{cloud_api_base_url, is_cloud_sync_enabled};\n",
    "tauri services import",
  );

  content = replaceOnce(
    content,
    `const SYNC_ACCESS_TOKEN_KEY: &str = "sync_access_token";
const SYNC_REFRESH_TOKEN_KEY: &str = "sync_refresh_token";
`,
    `const SYNC_ACCESS_TOKEN_KEY: &str = "sync_access_token";
const SYNC_REFRESH_TOKEN_KEY: &str = "sync_refresh_token";

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectConfigResponse {
    pub enabled: bool,
    pub auth_url: Option<String>,
    pub auth_publishable_key: Option<String>,
    pub api_url: Option<String>,
    pub oauth_callback_url: Option<String>,
}

#[tauri::command]
pub async fn get_connect_config() -> Result<ConnectConfigResponse, String> {
    let auth_url = option_env!("CONNECT_AUTH_URL")
        .map(|v| v.trim().trim_end_matches('/').to_string())
        .filter(|v| !v.is_empty());
    let publishable_key = option_env!("CONNECT_AUTH_PUBLISHABLE_KEY")
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty());
    let api_url = cloud_api_base_url();
    let oauth_callback_url = option_env!("CONNECT_OAUTH_CALLBACK_URL")
        .map(|v| v.trim().trim_end_matches('/').to_string())
        .filter(|v| !v.is_empty());

    let enabled = auth_url.is_some()
        && publishable_key.is_some()
        && is_cloud_sync_enabled();

    Ok(ConnectConfigResponse {
        enabled,
        auth_url,
        auth_publishable_key: publishable_key,
        api_url,
        oauth_callback_url,
    })
}
`,
    "tauri connect config command",
  );

  writeText("apps/tauri/src/commands/wealthfolio_connect.rs", content);

  content = readText("apps/tauri/src/lib.rs");
  content = insertAfter(
    content,
    "            // Sync commands\n",
    "            commands::wealthfolio_connect::get_connect_config,\n",
    "tauri command registration",
  );
  writeText("apps/tauri/src/lib.rs", content);

  content = readText("apps/tauri/src/services/mod.rs");
  content = replaceOnce(
    content,
    "pub use connect_service::{cloud_api_base_url, ConnectService};\n",
    "pub use connect_service::{cloud_api_base_url, is_cloud_sync_enabled, ConnectService};\n",
    "tauri services export",
  );
  writeText("apps/tauri/src/services/mod.rs", content);
}

function main() {
  updateBackend();
  updateServerCsp();
  updateFrontendCore();
  updateConnectionStatus();
  updateFrontendConnectConfig();
  updateFrontendProvider();
  updateTauri();
  console.log("Applied connect config transformations.");
}

main();
