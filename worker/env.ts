import type { User } from "../shared/types";

export interface Env {
  DB: D1Database;
  AI: Ai;
  ASSETS: Fetcher;
  AI_MODEL: string;
  LIMIT_TRANSCRIPTS_PER_DAY: string;
  /** uncached AI calls for analysis (punctuation + translation) per user and day */
  LIMIT_AI_CALLS_PER_DAY?: string;
  LIMIT_LOOKUPS_PER_DAY: string;
  LIMIT_GUEST_LOOKUPS_PER_DAY: string;
  BACKUP_QUOTA_BYTES: string;
  GOOGLE_CLIENT_ID: string;
  GOOGLE_CLIENT_SECRET?: string;
  /** transcript provider key (wrangler secret) */
  SUPADATA_API_KEY?: string;
  /** "1" enables /api/auth/dev-login. Local development and tests only. */
  DEV_AUTH?: string;
  /** "1" returns canned AI responses. Local development and E2E only. */
  AI_MOCK?: string;
  /** "1" serves generated transcripts instead of calling the provider. Local development and E2E only. */
  TRANSCRIPT_MOCK?: string;
}

export type AppEnv = { Bindings: Env; Variables: { user: User | null } };
