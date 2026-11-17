export interface Env {
  DB: D1Database;
  MATCHES: DurableObjectNamespace;
  ASSETS: Fetcher;
  MODE?: string;
  ADMIN_TOKEN?: string;
  RUNNER_TOKEN?: string;
  PROVIDER_WEBHOOK_TOKEN?: string;
  TELEGRAM_BOT_TOKEN?: string;
  TELEGRAM_CHANNEL_ID?: string;
  TELEGRAM_TEST_CHANNEL_ID?: string;
  PRODUCTION_CONFIRM?: string;
  PROVIDER?: string;
  PANDASCORE_TOKEN?: string;
  PROVIDER_POLLING_APPROVED?: string;
  PROVIDER_MIN_POLL_SECONDS?: string;
  POLL_SECONDS?: string;
  CODEX_ENABLED?: string;
}
export type Category =
  | "TRANSFER"
  | "MATCH_RESULT"
  | "ROSTER"
  | "UPDATE"
  | "GENERAL_NEWS";
export interface Post {
  id: string;
  event_key: string;
  category: Category;
  status: string;
  caption: string;
  png: ArrayBuffer | null;
  created_at: number;
  received_at: number;
  occurred_at: number | null;
  sent_at: number | null;
  attempt: number;
  message_id?: number;
  source_url?: string;
}
export interface Prepared {
  [winner: string]: {
    title: string;
    body: string;
    graphics: { accent: string; background: string };
  };
}
export const categories: Category[] = [
  "TRANSFER",
  "MATCH_RESULT",
  "ROSTER",
  "UPDATE",
  "GENERAL_NEWS",
];
