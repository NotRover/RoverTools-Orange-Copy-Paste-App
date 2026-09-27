// Turn a Tauri command rejection into text a user can act on.
//
// Rust rejects with plain strings. The ones written for people are sentences
// and pass through unchanged. API failures arrive as `<call tag> <status>:
// <detail>` or `<call tag>: <transport problem>` (see `sync/client.rs`), which
// are written for the log: those are mapped by status, and anything that is
// not a readable sentence falls back to the caller's own text. Every surface
// that shows an error routes through here so no screen shows the raw string.

const SIGN_IN = "Sign in on the Account screen first.";
const OFFLINE = "Cannot reach the server. Check your connection and try again.";

// A call tag is lowercase words, an optional HTTP status, then ": ".
const TAGGED = /^[a-z][\w ./-]*?(?: (\d{3}))?: ([\s\S]*)$/;

function isSentence(s: string): boolean {
  return /^[A-Z]/.test(s) && /[.!?]$/.test(s) && !/[{}_]/.test(s);
}

export function userError(e: unknown, fallback: string): string {
  const raw = (
    typeof e === "string" ? e : e instanceof Error ? e.message : ""
  ).trim();
  if (!raw) return fallback;
  // Rust spells "no session" three ways; they all mean the same next step.
  if (/\b(not authenticated|not signed in|sync not enabled)\b/i.test(raw)) {
    return SIGN_IN;
  }

  const tagged = raw.match(TAGGED);
  if (!tagged) return isSentence(raw) ? raw : fallback;

  const [, code, detail] = tagged;
  if (!code) {
    return /timed out|could not reach|cut short|request failed|incomplete/i.test(detail)
      ? OFFLINE
      : fallback;
  }
  const status = Number(code);
  if (status === 401) return "Your session expired. Sign in again on the Account screen.";
  if (status === 402) {
    return "Cloud storage is full. Remove some synced images or files to make room.";
  }
  if (status === 403 && detail.includes("email_unverified")) {
    return "Confirm your email address first. The link is in your inbox.";
  }
  if (status === 403) return "This account does not have access to that.";
  if (status === 429) return "Too many tries. Wait a minute and try again.";
  if (status >= 500) return "The server is having trouble. Try again in a few minutes.";
  return isSentence(detail) ? detail : fallback;
}
