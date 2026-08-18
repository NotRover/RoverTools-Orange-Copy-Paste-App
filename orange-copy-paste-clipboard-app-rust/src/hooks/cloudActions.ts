import { invoke } from "@tauri-apps/api/core";
import { clearPending, markPending } from "./pendingRemoval";
import {
  deferDestructive,
  showToast,
  toastError,
} from "../components/app/toast/toastBus";

/**
 * Put items on the account, or take the server copies back off.
 *
 * Both screens and both bulk bars used to call these commands inline and
 * swallow the result, so an upload that never happened - not signed in, item no
 * longer in the store - looked exactly like one that did. The push itself is
 * asynchronous on the Rust side, so the wording says what is under way rather
 * than claiming it has landed; the card badge is what confirms it.
 */
export async function setCloudCopy(
  clientIds: string[],
  entryType: "clipboard" | "note",
  upload: boolean,
): Promise<void> {
  if (clientIds.length === 0) return;
  const noun = entryType === "note" ? "note" : "item";
  const plural = clientIds.length === 1 ? noun : `${clientIds.length} ${noun}s`;

  const badges = clientIds.map((id) => `cloud:${entryType}:${id}`);

  // Taking the server copies down cannot be walked back - the next device to
  // pull sees them gone - so the removal waits out an Undo toast. Uploading is
  // additive and goes straight away.
  if (!upload) {
    // The badge clears as the menu closes rather than when the toast runs out.
    // It stays cleared afterwards: what draws it is Rust state that only
    // catches up once the tombstone has synced, which on a manual or offline
    // device is not soon. Uploading the item again is what puts it back.
    const unhide = markPending(badges);
    deferDestructive(
      `Removing ${plural} from your account`,
      async () => {
        // Nothing was taken down - every item was another member's, or the
        // command failed - so the badges were telling the truth.
        if (!(await runCloudCopy(clientIds, entryType, false, plural))) unhide();
      },
      {
        key: "cloud-copy",
        onUndo: unhide,
        errorPrefix: "Could not remove from your account",
      },
    );
    return;
  }
  clearPending(badges);
  await runCloudCopy(clientIds, entryType, true, plural);
}

/** True when the server copies actually changed. */
async function runCloudCopy(
  clientIds: string[],
  entryType: "clipboard" | "note",
  upload: boolean,
  plural: string,
): Promise<boolean> {
  try {
    const count = await invoke<number>(
      upload ? "sync_push_entries" : "sync_unpush_entries",
      { clientIds, entryType },
    );
    if (count === 0) {
      showToast(`Nothing to ${upload ? "upload" : "remove"}`, "error", {
        key: "cloud-copy",
      });
      return false;
    }
    if (upload) {
      showToast(`Uploading ${plural} to your account`, "info", {
        key: "cloud-copy",
      });
    }
    return true;
  } catch (e) {
    toastError(
      upload ? "Could not upload" : "Could not remove from your account",
      e,
    );
    return false;
  }
}
