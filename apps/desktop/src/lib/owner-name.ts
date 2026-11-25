import type { SuupClient } from "@suup/api";
import { pendingOwnerName, setPendingOwnerName } from "./welcome.js";

/**
 * Once a server is connected: sends the name typed in the welcome, if there is one that no server
 * has received (only when the server has none yet: it never overwrites the name it knows), and
 * answers with the name the server has (`null` until the person says it). A failure to send keeps
 * the name for the next connection; a failure to read answers `null`.
 */
export async function syncOwnerName(api: SuupClient): Promise<string | null> {
  const pending = pendingOwnerName();
  try {
    if (pending !== null) {
      const settings = await api.userSettings.update({
        ownerName: pending,
        ownerNameIfEmpty: true,
      });
      setPendingOwnerName(null);
      return settings.ownerName;
    }
    return (await api.userSettings.get()).ownerName;
  } catch {
    return null;
  }
}
