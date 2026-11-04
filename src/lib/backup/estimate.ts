import { DAILY_DAYS, MONTHLY_MONTHS, YEARLY_YEARS } from "./retention";

/**
 * Rough backup-storage estimate (docs/backup-restore.md → "Estimating storage and cost").
 *
 *   database:  N × r × S          N = 35 daily + 12 month-end + 7 year-end = 54 copies (upper bound),
 *                                 S = database size, r = compressed-export ratio (measured)
 *   documents: D + 365·c·y + x·7  D = document bytes today, c = new document bytes per day,
 *                                 y = years ahead, x = bytes deleted per year (kept while a year-end
 *                                 backup still lists them, up to 7 years)
 *   manifests: N × F × m          F = file count, m = manifest bytes per file (compressed)
 *   overhead:  F × 72 bytes       36 bytes app encryption + 36 bytes backup encryption per file
 *
 * Documents are stored once (incremental, by storage key) no matter how many nights list them.
 */
export const DB_COPIES = DAILY_DAYS + MONTHLY_MONTHS + YEARLY_YEARS;
export const PER_FILE_OVERHEAD = 72;

export type EstimateInput = {
  documentBytes: number;
  fileCount: number;
  dbBytes: number;
  dbCompressedRatio: number;
  newDocumentBytesPerDay: number;
  deletedBytesPerYear: number;
  manifestBytesPerFile: number;
  yearsAhead?: number;
};

export function estimateBackupStorage(i: EstimateInput) {
  const y = i.yearsAhead ?? 0;
  const database = DB_COPIES * i.dbCompressedRatio * i.dbBytes;
  const documents = i.documentBytes + 365 * i.newDocumentBytesPerDay * y + i.deletedBytesPerYear * Math.min(YEARLY_YEARS, Math.max(1, y || 1));
  const files = i.fileCount + Math.round((365 * i.newDocumentBytesPerDay * y) / Math.max(1, i.documentBytes / Math.max(1, i.fileCount)));
  const manifests = DB_COPIES * files * i.manifestBytesPerFile;
  const overhead = files * PER_FILE_OVERHEAD;
  const total = database + documents + manifests + overhead;
  return { database, documents, manifests, overhead, total, dbCopies: DB_COPIES };
}

/** Monthly cost at a price per GB-month (e.g. B2 ≈ $0.006, R2 ≈ $0.015, S3 Standard ≈ $0.023). */
export const monthlyCost = (bytes: number, pricePerGbMonth: number) => (bytes / 1e9) * pricePerGbMonth;
