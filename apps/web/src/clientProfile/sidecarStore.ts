import {
  ClientProfileSidecarSchema,
  emptyClientProfileSidecar,
} from "@t3tools/client-runtime/client-profile/merge";
import type { ClientProfileSidecarStore } from "@t3tools/client-runtime/client-profile/source";

import {
  getLocalStorageItem,
  setLocalStorageItem,
  subscribeLocalStorageKey,
} from "../hooks/useLocalStorage";

export const CLIENT_PROFILE_SIDECAR_STORAGE_KEY = "t3code:client-profile-sync:v1";

// crypto.randomUUID is unavailable on plain-HTTP LAN origins.
function randomDeviceId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function readSidecar() {
  try {
    return getLocalStorageItem(CLIENT_PROFILE_SIDECAR_STORAGE_KEY, ClientProfileSidecarSchema);
  } catch {
    return null;
  }
}

export function createWebSidecarStore(): ClientProfileSidecarStore {
  return {
    load: async () => {
      const stored = readSidecar();
      if (stored !== null) return stored;
      const fresh = emptyClientProfileSidecar(randomDeviceId());
      setLocalStorageItem(CLIENT_PROFILE_SIDECAR_STORAGE_KEY, fresh, ClientProfileSidecarSchema);
      return fresh;
    },
    save: async (sidecar) => {
      setLocalStorageItem(CLIENT_PROFILE_SIDECAR_STORAGE_KEY, sidecar, ClientProfileSidecarSchema);
    },
    subscribe: (onChange) => subscribeLocalStorageKey(CLIENT_PROFILE_SIDECAR_STORAGE_KEY, onChange),
  };
}
