/**
 * BlueBubbles bridge — receives iMessage messages and sends replies via the
 * BlueBubbles Server REST API + webhooks.
 *
 * Lifted in spirit from SherlockKulkarni/src/channels/bluebubbles-bridge.ts,
 * stripped of OpenClaw coupling. This is a small library — the actual webhook
 * route + agent dispatch lives in src/bridge/index.ts.
 */

import { createLogger } from "../shared/logger.js";
import { optionalEnv } from "../shared/env.js";

const log = createLogger("bridge:bluebubbles");

const IMESSAGE_MAX = 10_000;

export interface IMessageIncoming {
  from: string;          // Phone (+15...) or Apple ID email
  text: string;
  messageId: string;
  chatGuid: string;      // e.g. "iMessage;-;+15551234567"
  timestamp: number;
  isGroup: boolean;
  fromMe: boolean;
}

function bbUrl(): string { return optionalEnv("BLUEBUBBLES_URL") ?? "http://localhost:1234"; }
function bbPwd(): string { return optionalEnv("BLUEBUBBLES_PASSWORD") ?? ""; }

// ─── Sender normalization ───────────────────────────────────────────

export function normalizeSender(from: string): string {
  return from.replace(/^iMessage;[+-];/, "").trim();
}

// ─── Format text for iMessage delivery ──────────────────────────────

export function formatForIMessage(text: string): string[] {
  const cleaned = text
    .replace(/\*\*(.*?)\*\*/g, "$1")
    .replace(/#{1,6}\s+/g, "")
    .replace(/`{3}[\s\S]*?`{3}/g, (m) => m.replace(/`{3}\w*\n?/g, ""));

  if (cleaned.length <= IMESSAGE_MAX) return [cleaned];

  const chunks: string[] = [];
  let rest = cleaned;
  while (rest.length > 0) {
    if (rest.length <= IMESSAGE_MAX) { chunks.push(rest); break; }
    let splitAt = rest.lastIndexOf("\n\n", IMESSAGE_MAX);
    if (splitAt < IMESSAGE_MAX / 2) splitAt = rest.lastIndexOf(". ", IMESSAGE_MAX);
    if (splitAt < 0) splitAt = IMESSAGE_MAX;
    chunks.push(rest.slice(0, splitAt + 1).trim());
    rest = rest.slice(splitAt + 1).trim();
  }
  return chunks;
}

// ─── Send a message via BlueBubbles ─────────────────────────────────

export async function sendIMessage(chatGuid: string, text: string): Promise<boolean> {
  if (!bbPwd()) {
    log.warn("BLUEBUBBLES_PASSWORD not set; can't send");
    return false;
  }
  const url = `${bbUrl()}/api/v1/message/text?password=${encodeURIComponent(bbPwd())}`;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chatGuid,
        message: text,
        tempGuid: `sherlock-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        method: "apple-script",
      }),
      signal: AbortSignal.timeout(15_000),
    });
    if (res.ok) {
      log.info({ chatGuid, len: text.length }, "iMessage sent");
      return true;
    }
    log.error({ chatGuid, status: res.status, body: await res.text() }, "Send failed");
    return false;
  } catch (err) {
    log.error({ chatGuid, err: err instanceof Error ? err.message : String(err) }, "Send error");
    return false;
  }
}

export async function sendIMessageChunked(chatGuid: string, text: string): Promise<boolean> {
  const chunks = formatForIMessage(text);
  let allOk = true;
  for (const chunk of chunks) {
    const ok = await sendIMessage(chatGuid, chunk);
    allOk = allOk && ok;
  }
  return allOk;
}

// ─── Parse an incoming BlueBubbles webhook payload ─────────────────

export function parseWebhook(body: Record<string, unknown>): IMessageIncoming | null {
  if (body.type !== "new-message") return null;
  const msg = body.data as Record<string, unknown> | undefined;
  if (!msg) return null;

  const isFromMe = msg["is_from_me"] === true || msg["isFromMe"] === true;
  if (isFromMe) return null;

  const text = (msg["text"] as string) ?? "";
  if (!text.trim()) return null;

  const handle = msg["handle"] as Record<string, unknown> | undefined;
  const from = (handle?.["address"] as string) ?? (msg["address"] as string) ?? (msg["sender"] as string) ?? "";
  if (!from) return null;

  const chats = msg["chats"] as Array<Record<string, unknown>> | undefined;
  const firstChat = chats?.[0];
  const chatGuid = (firstChat?.["guid"] as string) ?? (msg["chatGuid"] as string) ?? `iMessage;-;${from}`;
  const participants = firstChat?.["participants"] as unknown[] | undefined;

  return {
    from: normalizeSender(from),
    text,
    messageId: String(msg["guid"] ?? msg["id"] ?? Date.now()),
    chatGuid,
    timestamp: typeof msg["dateCreated"] === "number" ? (msg["dateCreated"] as number) : Date.now(),
    isGroup: (participants?.length ?? 0) > 1,
    fromMe: false,
  };
}

// ─── Webhook self-registration ──────────────────────────────────────

export async function registerWebhook(callbackUrl: string): Promise<boolean> {
  if (!bbPwd()) return false;
  try {
    const listRes = await fetch(`${bbUrl()}/api/v1/webhook?password=${encodeURIComponent(bbPwd())}`, {
      signal: AbortSignal.timeout(5_000),
    });
    if (listRes.ok) {
      const list = await listRes.json() as { data?: Array<{ url: string; id: number }> };
      if (list.data?.some((w) => w.url === callbackUrl)) {
        log.info({ callbackUrl }, "webhook already registered");
        return true;
      }
    }
    const createRes = await fetch(`${bbUrl()}/api/v1/webhook?password=${encodeURIComponent(bbPwd())}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: callbackUrl, events: ["new-message"] }),
      signal: AbortSignal.timeout(5_000),
    });
    if (createRes.ok) {
      log.info({ callbackUrl }, "✓ webhook registered");
      return true;
    }
    log.warn({ callbackUrl, status: createRes.status }, "webhook registration failed");
    return false;
  } catch (err) {
    log.warn({ err: err instanceof Error ? err.message : String(err) }, "webhook registration error");
    return false;
  }
}
