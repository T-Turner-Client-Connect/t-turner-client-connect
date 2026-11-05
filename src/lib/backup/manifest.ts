/** What each nightly manifest records. It lists the FULL set of files at that point, so any night can be restored on its own. */
export type ChunkEntry = { key: string; rows: number; sha256: string; objectSha256: string; bytes: number };
export type TableEntry = { name: string; rows: number; chunks: ChunkEntry[] };
export type FileEntry = {
  storageKey: string;
  objectKey: string;
  sourceType: string;
  sourceId: string;
  group: string | null;
  // sha256 of the bytes as the app stores them (app-encrypted), of the uploaded object, and of the original document.
  storedSha256: string;
  objectSha256: string;
  plainSha256: string | null;
  sizeBytes: number;
};

export type Manifest = {
  format: "tturner-backup/1";
  runId: string;
  backupDate: string;
  createdAt: string;
  lastMigration: string | null;
  schemaFingerprint: string;
  appKeyVersion: string;
  backupKeyId: string;
  tables: TableEntry[];
  files: FileEntry[];
  totals: { tables: number; rows: number; files: number; fileBytes: number };
};

export const MANIFEST_NAME = "manifest.json.tcb";
export const runPrefix = (backupDate: string, runId: string) => `runs/${backupDate}_${runId}/`;
