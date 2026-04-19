/**
 * Google OAuth client credentials for Gemini CLI and Antigravity flows.
 *
 * These are the OAuth client IDs / secrets registered for the Gemini CLI
 * and Antigravity installed applications. They are intentionally embedded
 * in the respective upstream open-source CLIs, but GitHub push-protection
 * treats them as secrets, so we keep them out of version control here.
 *
 * To enable Google OAuth login:
 *   1. Copy this file to `google-oauth-secrets.ts` (same directory).
 *   2. Fill in the base64-encoded values below. You can retrieve them from:
 *        - Gemini CLI upstream source
 *          (https://github.com/google-gemini/gemini-cli)
 *        - Antigravity upstream source
 *        or from the `GOOGLE_GEMINI_CLI_CLIENT_ID` /
 *        `GOOGLE_GEMINI_CLI_CLIENT_SECRET` /
 *        `GOOGLE_ANTIGRAVITY_CLIENT_ID` /
 *        `GOOGLE_ANTIGRAVITY_CLIENT_SECRET` env vars at runtime.
 *
 * The file `google-oauth-secrets.ts` is listed in .gitignore and must never
 * be committed.
 */

export const GEMINI_CLI_CLIENT_ID_B64 = "";
export const GEMINI_CLI_CLIENT_SECRET_B64 = "";

export const ANTIGRAVITY_CLIENT_ID_B64 = "";
export const ANTIGRAVITY_CLIENT_SECRET_B64 = "";
