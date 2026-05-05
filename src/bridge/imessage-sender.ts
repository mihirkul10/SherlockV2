/**
 * iMessage outbound sender via osascript.
 *
 * Replaces the BlueBubbles HTTP-to-AppleScript hop. We invoke `osascript`
 * directly against Messages.app; we control the timeout, retry, and recovery.
 *
 * Failure modes we explicitly handle:
 *   1. Messages.app not running    → relaunch with `open -a Messages`, retry
 *   2. AppleScript timeout         → retry once with longer timeout
 *   3. iMessage service unavailable→ surface error, no retry
 *
 * We chunk long messages because iMessage has a per-message size limit
 * (the formatForIMessage helper handles this — same shape as the old
 * BB sender). Markdown is stripped because iMessage doesn't render it.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createLogger } from "../shared/logger.js";

const exec = promisify(execFile);
const log = createLogger("bridge:imessage-sender");

const IMESSAGE_MAX = 10_000;
const SEND_TIMEOUT_MS_FIRST = 30_000;
const SEND_TIMEOUT_MS_RETRY = 60_000;

// ─── Format ────────────────────────────────────────────────────────────

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

// ─── Chat-guid → addressee parsing ────────────────────────────────────

interface AddressedTarget {
  service: "iMessage" | "SMS";
  addressee: string;
}

function parseChatGuid(chatGuid: string): AddressedTarget | null {
  // Examples:
  //   "iMessage;-;mihirkul10@gmail.com"
  //   "iMessage;+;chat123456"   (group, prefix +)
  //   "SMS;-;+15551234567"
  //   "any;-;mihirkul10@gmail.com"  (legacy/test alias)
  const m = chatGuid.match(/^([^;]+);[+-];(.+)$/);
  if (!m) return null;
  const [, rawService, addressee] = m;
  let service: "iMessage" | "SMS";
  if (/^sms$/i.test(rawService)) service = "SMS";
  else service = "iMessage";   // "any" and "iMessage" both → iMessage
  return { service, addressee };
}

// ─── AppleScript builder ──────────────────────────────────────────────

function buildAppleScript(target: AddressedTarget, message: string): string[] {
  // Use buddy-by-handle path because chat-id-based sends are flaky on Tahoe
  // when chat hasn't been opened recently. Buddy-based always works as long
  // as Messages.app is signed in.
  //
  // We pass the message as a separate -e line so AppleScript handles quoting
  // for us via the `set msg to ...` pattern; only the message string needs
  // careful escaping.
  const escapedMsg = message
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"');

  return [
    `tell application "Messages"`,
    `set targetService to first service whose service type = ${target.service}`,
    `set targetBuddy to buddy "${target.addressee}" of targetService`,
    `send "${escapedMsg}" to targetBuddy`,
    `end tell`,
  ];
}

// ─── Messages.app lifecycle ───────────────────────────────────────────

async function isMessagesRunning(): Promise<boolean> {
  try {
    const { stdout } = await exec("/usr/bin/pgrep", ["-x", "Messages"], { timeout: 3000 });
    return stdout.trim().length > 0;
  } catch {
    return false;
  }
}

async function launchMessages(): Promise<void> {
  log.info("launching Messages.app");
  try {
    await exec("/usr/bin/open", ["-a", "Messages"], { timeout: 5000 });
  } catch (err) {
    log.warn(
      { err: err instanceof Error ? err.message : String(err) },
      "open -a Messages failed; trying full path"
    );
    try {
      await exec("/usr/bin/open", ["/System/Applications/Messages.app"], { timeout: 5000 });
    } catch (e) {
      log.error(
        { err: e instanceof Error ? e.message : String(e) },
        "could not launch Messages.app"
      );
      throw e;
    }
  }
  // Give Messages.app a moment to come up + log into iCloud before AppleScript hits it.
  await new Promise((r) => setTimeout(r, 3000));
}

// ─── Single attempt ───────────────────────────────────────────────────

async function sendOnce(target: AddressedTarget, message: string, timeoutMs: number): Promise<{ ok: boolean; err?: string }> {
  const lines = buildAppleScript(target, message);
  const args: string[] = [];
  for (const line of lines) { args.push("-e", line); }
  try {
    const { stderr } = await exec("/usr/bin/osascript", args, {
      timeout: timeoutMs,
      maxBuffer: 1 << 20,
    });
    // osascript can succeed silently or with a buddy reference printed to stdout.
    // stderr usually empty on success; warnings sometimes show up but the send still went.
    if (stderr && /error/i.test(stderr) && !/system font/i.test(stderr)) {
      return { ok: false, err: stderr.trim().slice(0, 400) };
    }
    return { ok: true };
  } catch (err) {
    const e = err as { code?: string; stderr?: string; signal?: string; message?: string };
    if (e.signal === "SIGTERM" || /timed out|timeout/i.test(e.message ?? "")) {
      return { ok: false, err: "timeout" };
    }
    const detail = (e.stderr ?? e.message ?? String(err)).slice(0, 400);
    return { ok: false, err: detail };
  }
}

// ─── Public send ──────────────────────────────────────────────────────

export async function sendIMessage(chatGuid: string, text: string): Promise<boolean> {
  const target = parseChatGuid(chatGuid);
  if (!target) {
    log.error({ chatGuid }, "could not parse chat_guid");
    return false;
  }
  // Pre-flight: if Messages.app isn't running, launch it before the first
  // attempt — saves 30s of guaranteed timeout.
  if (!(await isMessagesRunning())) {
    log.warn({ chatGuid }, "Messages.app not running; launching before send");
    try { await launchMessages(); } catch { /* error already logged; try osascript anyway, it'll fail clearly */ }
  }

  const first = await sendOnce(target, text, SEND_TIMEOUT_MS_FIRST);
  if (first.ok) {
    log.info({ chatGuid, len: text.length, attempt: 1 }, "iMessage sent");
    return true;
  }
  log.warn({ chatGuid, err: first.err, attempt: 1 }, "send failed; recovering");

  // Recovery: relaunch Messages.app and retry once with a longer timeout.
  // Most failures we see are: (a) Messages.app died, (b) iCloud sync lock.
  // Both clear after a relaunch + a few seconds wait.
  try { await launchMessages(); } catch { /* keep going */ }
  const second = await sendOnce(target, text, SEND_TIMEOUT_MS_RETRY);
  if (second.ok) {
    log.info({ chatGuid, len: text.length, attempt: 2 }, "iMessage sent on retry");
    return true;
  }
  log.error({ chatGuid, err: second.err, attempt: 2 }, "send failed after retry");
  return false;
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
