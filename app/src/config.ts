// Build-time settings. Override with VITE_* environment variables (see scripts/build.js), e.g.
// VITE_TREEHUB_API=http://localhost:8787 VITE_TREEHUB_DEV_LOGIN=true npm run build

// Vite replaces import.meta.env when building; it is undefined when unit tests run the code in Node
const env: Partial<ImportMetaEnv> = import.meta.env || {};

/** TreeHub backend (Cloudflare Worker). */
export const API_URL = (env.VITE_TREEHUB_API || 'https://treehub-api.peterxcli.workers.dev').replace(/\/+$/, '');

/** Offer the backend's dev sign-in (only works when the backend runs with DEV_AUTH=true). */
export const DEV_LOGIN = env.VITE_TREEHUB_DEV_LOGIN === 'true';

export const GITHUB_API = 'https://api.github.com';

/** How often queued pull requests are refreshed in the background. */
export const REFRESH_MINUTES = 15;

/** Opening the dashboard refreshes statuses older than this. */
export const STALE_MS = 2 * 60 * 1000;
