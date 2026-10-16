/** D1 access. Raw prepared statements; no ORM for this slice.
 *
 * Dates are ISO-8601 TEXT (D1 is SQLite). IDs are UUIDs generated in the
 * Worker. Only the asset helpers needed by T2 live here; channels/jobs/series
 * queries land with their routes (T3-T6).
 */

export interface AssetRow {
  id: string;
  storage_key: string;
  size_bytes: number;
  created_at: string;
}

export async function insertAsset(
  db: D1Database,
  row: { id: string; storageKey: string; sizeBytes: number },
): Promise<AssetRow> {
  const created = await db
    .prepare(
      "INSERT INTO assets (id, storage_key, size_bytes) VALUES (?, ?, ?) RETURNING id, storage_key, size_bytes, created_at",
    )
    .bind(row.id, row.storageKey, row.sizeBytes)
    .first<AssetRow>();
  if (!created) {
    throw new Error("failed to insert asset");
  }
  return created;
}

export async function getAssetByStorageKey(
  db: D1Database,
  storageKey: string,
): Promise<AssetRow | null> {
  return await db
    .prepare("SELECT id, storage_key, size_bytes, created_at FROM assets WHERE storage_key = ?")
    .bind(storageKey)
    .first<AssetRow>();
}

export async function getAssetById(db: D1Database, id: string): Promise<AssetRow | null> {
  return await db
    .prepare("SELECT id, storage_key, size_bytes, created_at FROM assets WHERE id = ?")
    .bind(id)
    .first<AssetRow>();
}
