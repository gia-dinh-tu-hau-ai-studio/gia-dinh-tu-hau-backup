export type OfflineTicketDraft = {
  shiftId: number;
  businessId: number;
  venueId: number;
  payload: unknown;
  updatedBy: string;
  savedAt: string;
  pending: boolean;
};

const DB_NAME = "tu-hau-offline";
const STORE_NAME = "ticket-drafts";
const DB_VERSION = 1;

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(STORE_NAME)) database.createObjectStore(STORE_NAME, { keyPath: "shiftId" });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export async function putOfflineTicketDraft(draft: OfflineTicketDraft) {
  if (typeof indexedDB === "undefined") return;
  const database = await openDatabase();
  await new Promise<void>((resolve, reject) => {
    const transaction = database.transaction(STORE_NAME, "readwrite");
    transaction.objectStore(STORE_NAME).put(draft);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
  });
  database.close();
}

export async function getOfflineTicketDraft(shiftId: number): Promise<OfflineTicketDraft | null> {
  if (typeof indexedDB === "undefined") return null;
  const database = await openDatabase();
  const result = await new Promise<OfflineTicketDraft | null>((resolve, reject) => {
    const request = database.transaction(STORE_NAME, "readonly").objectStore(STORE_NAME).get(shiftId);
    request.onsuccess = () => resolve((request.result as OfflineTicketDraft | undefined) || null);
    request.onerror = () => reject(request.error);
  });
  database.close();
  return result;
}

export async function getPendingOfflineTicketDrafts(): Promise<OfflineTicketDraft[]> {
  if (typeof indexedDB === "undefined") return [];
  const database = await openDatabase();
  const result = await new Promise<OfflineTicketDraft[]>((resolve, reject) => {
    const request = database.transaction(STORE_NAME, "readonly").objectStore(STORE_NAME).getAll();
    request.onsuccess = () => resolve(((request.result || []) as OfflineTicketDraft[]).filter(item => item.pending));
    request.onerror = () => reject(request.error);
  });
  database.close();
  return result;
}

export async function markOfflineTicketDraftSynced(shiftId: number, savedAt: string) {
  const current = await getOfflineTicketDraft(shiftId);
  if (!current || current.savedAt > savedAt) return;
  await putOfflineTicketDraft({ ...current, savedAt, pending: false });
}
