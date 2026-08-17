import { invoke } from "@tauri-apps/api/core";
import { showToast, toastError } from "../components/app/toast/toastBus";

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

  try {
    const count = await invoke<number>(
      upload ? "sync_push_entries" : "sync_unpush_entries",
      { clientIds, entryType },
    );
    if (count === 0) {
      showToast(`Nothing to ${upload ? "upload" : "remove"}`, "error", {
        key: "cloud-copy",
      });
      return;
    }
    showToast(
      upload
        ? `Uploading ${plural} to your account`
        : `Removing ${plural} from your account`,
      "info",
      { key: "cloud-copy" },
    );
  } catch (e) {
    toastError(
      upload ? "Could not upload" : "Could not remove from your account",
      e,
    );
  }
}
