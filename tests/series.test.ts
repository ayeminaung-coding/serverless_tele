import { beforeEach, describe, expect, it } from "vitest";
import { app, type Env } from "../src/index";
import {
  SeriesValidationError,
  decodeHashtags,
  encodeHashtags,
  validatePartCreate,
  validatePartPatch,
  validateSeriesCreate,
  validateSeriesPatch,
} from "../src/series";

/** In-memory D1 stub covering the statements series/parts/assets/channels emit. */
interface RowMap extends Map<string, Record<string, unknown>> {}

function createFakeDb() {
  const assets: RowMap = new Map();
  const channels: RowMap = new Map();
  const series: RowMap = new Map();
  const parts: RowMap = new Map();
  const now = () => new Date().toISOString();

  function find(table: RowMap, pred: (row: Record<string, unknown>) => boolean) {
    for (const row of table.values()) {
      if (pred(row)) return row;
    }
    return undefined;
  }

  const db = {
    prepare(sql: string) {
      const q = sql.replace(/\s+/g, " ").trim();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const stmt: any = {
        bind(...params: Array<string | number | null>) {
          const str = (i: number): string => String(params[i]);
          const num = (i: number): number => Number(params[i]);
          return {
            first: async <T>(): Promise<T | null> => {
              // --- INSERTS ---
              if (q.startsWith("INSERT INTO assets")) {
                const row = { id: str(0), storage_key: str(1), size_bytes: num(2), created_at: now() };
                assets.set(row.id, row);
                return (row as unknown) as T;
              }
              if (q.startsWith("INSERT INTO telegram_channels")) {
                if (find(channels, (r) => r["chat_id"] === str(2))) {
                  throw new Error("UNIQUE constraint failed: telegram_channels.chat_id");
                }
                const row = {
                  id: str(0), label: str(1), chat_id: str(2),
                  is_public: num(3), protect_content: num(4), enabled: num(5), created_at: now(),
                };
                channels.set(row.id, row);
                return (row as unknown) as T;
              }
              if (q.startsWith("INSERT INTO series_parts")) {
                if (find(parts, (r) => r["series_id"] === str(1) && r["part_index"] === num(3))) {
                  throw new Error("UNIQUE constraint failed: series_parts.series_id, series_parts.part_index");
                }
                if (find(parts, (r) => r["asset_id"] === str(2))) {
                  throw new Error("UNIQUE constraint failed: series_parts.asset_id");
                }
                const row = {
                  id: str(0), series_id: str(1), asset_id: str(2), part_index: num(3),
                  hook: str(4), source_filename: str(5), created_at: now(),
                };
                parts.set(row.id, row);
                return (row as unknown) as T;
              }
              if (q.startsWith("INSERT INTO series (")) {
                if (find(series, (r) => r["slug"] === str(1))) {
                  throw new Error("UNIQUE constraint failed: series.slug");
                }
                const row = {
                  id: str(0), slug: str(1), title_local: str(2), title_en: str(3),
                  synopsis: str(4), language: str(5), style_example: str(6),
                  total_parts: (params[7] as number | null) ?? null,
                  caption_template: str(8), title_template: str(9),
                  next_teaser_template: str(10), hashtags: str(11), channel_ids: str(12),
                  created_at: now(),
                };
                series.set(row.id, row);
                return (row as unknown) as T;
              }
              // --- UPDATES ---
              if (q.startsWith("UPDATE series_parts")) {
                const id = str(params.length - 1);
                const existing = parts.get(id);
                if (!existing) return null as unknown as T;
                const fields = q.split("SET ")[1]!.split(" WHERE")[0]!.split(",").map((s: string) => s.trim().split(" ")[0] ?? "");
                const next = { ...existing };
                fields.forEach((field: string, i: number) => {
                  next[field] = params[i] as string | number;
                });
                const clash = find(parts, (r) => r["id"] !== id && r["series_id"] === next["series_id"] && r["part_index"] === next["part_index"]);
                if (clash) throw new Error("UNIQUE constraint failed: series_parts.series_id, series_parts.part_index");
                parts.set(id, next);
                return (next as unknown) as T;
              }
              if (q.startsWith("UPDATE series SET")) {
                const id = str(params.length - 1);
                const existing = series.get(id);
                if (!existing) return null as unknown as T;
                const fields = q.split("SET ")[1]!.split(" WHERE")[0]!.split(",").map((s: string) => s.trim().split(" ")[0] ?? "");
                const next = { ...existing };
                fields.forEach((field: string, i: number) => {
                  next[field] = params[i] as string | number | null;
                });
                const clash = find(series, (r) => r["id"] !== id && r["slug"] === next["slug"]);
                if (clash) throw new Error("UNIQUE constraint failed: series.slug");
                series.set(id, next);
                return (next as unknown) as T;
              }
              // --- SELECTS: stats ---
              if (q.startsWith("SELECT COUNT(*)")) {
                const rows = [...parts.values()].filter((r) => r["series_id"] === str(0));
                const max = rows.reduce<number | null>((m, r) => Math.max(m ?? 0, r["part_index"] as number) || null, null);
                return ({ count: rows.length, max_index: rows.length ? max : null } as unknown) as T;
              }
              // --- SELECTS: parts ---
              if (q.includes("FROM series_parts")) {
                if (q.includes("WHERE series_id = ? AND part_index = ?")) {
                  return ((find(parts, (r) => r["series_id"] === str(0) && r["part_index"] === num(1)) ?? null) as unknown) as T | null;
                }
                if (q.includes("WHERE asset_id = ?")) {
                  return ((find(parts, (r) => r["asset_id"] === str(0)) ?? null) as unknown) as T | null;
                }
                if (q.includes("WHERE id = ?")) {
                  return ((parts.get(str(0)) ?? null) as unknown) as T | null;
                }
              }
              // --- SELECTS: series ---
              if (q.includes("FROM series ") || q.endsWith("FROM series")) {
                if (q.includes("WHERE slug = ?")) {
                  return ((find(series, (r) => r["slug"] === str(0)) ?? null) as unknown) as T | null;
                }
                if (q.includes("WHERE id = ?")) {
                  return ((series.get(str(0)) ?? null) as unknown) as T | null;
                }
              }
              // --- SELECTS: assets ---
              if (q.includes("FROM assets")) {
                if (q.includes("WHERE storage_key = ?")) {
                  return ((find(assets, (r) => r["storage_key"] === str(0)) ?? null) as unknown) as T | null;
                }
                return ((assets.get(str(0)) ?? null) as unknown) as T | null;
              }
              // --- SELECTS: channels ---
              if (q.includes("FROM telegram_channels") && q.includes("WHERE id = ?")) {
                return ((channels.get(str(0)) ?? null) as unknown) as T | null;
              }
              return null as unknown as T;
            },
            all: async <T>(): Promise<{ results: T[] }> => {
              if (q.includes("FROM series_parts")) {
                const rows = [...parts.values()]
                  .filter((r) => r["series_id"] === String(params[0]))
                  .sort((a, b) => (a["part_index"] as number) - (b["part_index"] as number));
                return { results: (rows as unknown) as T[] };
              }
              if (q.includes("FROM series")) {
                return { results: ([...series.values()] as unknown) as T[] };
              }
              return { results: [] as T[] };
            },
            run: async () => {
              if (q.startsWith("DELETE FROM series_parts")) {
                return { meta: { changes: parts.delete(String(params[0])) ? 1 : 0 } };
              }
              if (q.startsWith("DELETE FROM series")) {
                const id = String(params[0]);
                const deleted = series.delete(id);
                if (deleted) {
                  for (const [partId, row] of parts) {
                    if (row["series_id"] === id) parts.delete(partId);
                  }
                }
                return { meta: { changes: deleted ? 1 : 0 } };
              }
              if (q.startsWith("DELETE FROM telegram_channels")) {
                return { meta: { changes: channels.delete(String(params[0])) ? 1 : 0 } };
              }
              return { meta: { changes: 0 } };
            },
          };
        },
        first: async <T>(): Promise<T | null> => null as unknown as T | null,
        // listSeries() calls .all() with no bind; serve it from the same tables.
        all: async <T>(): Promise<{ results: T[] }> => {
          if (q.includes("FROM series_parts")) {
            const rows = [...parts.values()].sort(
              (a, b) => (a["part_index"] as number) - (b["part_index"] as number),
            );
            return { results: (rows as unknown) as T[] };
          }
          if (q.includes("FROM series")) {
            return { results: ([...series.values()] as unknown) as T[] };
          }
          return { results: [] as T[] };
        },
        run: async () => ({ meta: { changes: 0 } }),
      };
      return stmt;
    },
  };
  return db;
}

type FakeDb = ReturnType<typeof createFakeDb>;

function envWith(db: FakeDb): Env {
  return {
    DB: db as unknown as D1Database,
    MEDIA: {
      head: async () => ({ size: 1024 * 1024 }),
      delete: async () => undefined,
    } as unknown as R2Bucket,
    R2_ACCOUNT_ID: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    R2_BUCKET: "telegram-serverless-media",
    R2_ACCESS_KEY_ID: "test-access-key",
    R2_SECRET_ACCESS_KEY: "test-secret-key",
    R2_PUBLIC_BASE_URL: "",
    TELEGRAM_BOT_TOKEN: "test-token",
  };
}

async function postJson(db: FakeDb, path: string, payload: unknown, method = "POST") {
  return app.request(
    path,
    { method, headers: { "content-type": "application/json" }, body: JSON.stringify(payload) },
    envWith(db),
  );
}

async function createChannel(db: FakeDb, label: string, chat_id: string): Promise<string> {
  const res = await postJson(db, "/channels", { label, chat_id });
  expect(res.status).toBe(201);
  return ((await res.json()) as { id: string }).id;
}

async function createAsset(db: FakeDb, filename: string): Promise<string> {
  const intent = await postJson(db, "/assets/upload-url", { filename, size_bytes: 1024 });
  expect(intent.status).toBe(200);
  const { storage_key } = (await intent.json()) as { storage_key: string };
  const registered = await postJson(db, "/assets", { storage_key });
  expect(registered.status).toBe(201);
  return ((await registered.json()) as { id: string }).id;
}

describe("series validation", () => {
  it("requires a kebab-case slug", () => {
    expect(() => validateSeriesCreate({})).toThrowError(SeriesValidationError);
    expect(() => validateSeriesCreate({ slug: "My Show!" })).toThrowError(SeriesValidationError);
    expect(() => validateSeriesCreate({ slug: "UPPER" })).toThrowError(SeriesValidationError);
    expect(validateSeriesCreate({ slug: "my-show-s1" }).slug).toBe("my-show-s1");
  });

  it("rejects bad totals and channel picks", () => {
    expect(() => validateSeriesCreate({ slug: "s", total_parts: 0 })).toThrowError(SeriesValidationError);
    expect(() => validateSeriesCreate({ slug: "s", total_parts: 1.5 })).toThrowError(SeriesValidationError);
    expect(() => validateSeriesCreate({ slug: "s", channel_ids: "nope" })).toThrowError(SeriesValidationError);
    expect(() => validateSeriesCreate({ slug: "s", channel_ids: [42] })).toThrowError(SeriesValidationError);
  });

  it("dedupes channel picks", () => {
    expect(validateSeriesCreate({ slug: "s", channel_ids: ["a", "a", "b"] }).channelIds).toEqual(["a", "b"]);
  });

  it("encodes hashtags either way and decodes leniently", () => {
    expect(encodeHashtags("#a #b")).toBe("#a #b");
    expect(JSON.parse(encodeHashtags({ telegram: "#t" }) as string)).toEqual({ telegram: "#t" });
    expect(() => encodeHashtags(42)).toThrowError(SeriesValidationError);
    expect(decodeHashtags("#raw")).toBe("#raw");
    expect(decodeHashtags('{"telegram":"#t"}')).toEqual({ telegram: "#t" });
  });

  it("rejects empty patches and bad part input", () => {
    expect(() => validateSeriesPatch({})).toThrowError(SeriesValidationError);
    expect(() => validatePartPatch({})).toThrowError(SeriesValidationError);
    expect(() => validatePartCreate({ asset_id: "", part_index: 1 })).toThrowError(SeriesValidationError);
    expect(() => validatePartCreate({ asset_id: "a", part_index: 0 })).toThrowError(SeriesValidationError);
  });
});

describe("series routes", () => {
  let db: FakeDb;

  beforeEach(() => {
    db = createFakeDb();
  });

  it("CRUD round-trips", async () => {
    const created = await postJson(db, "/series", { slug: "my-show", title_local: "My Show" });
    expect(created.status).toBe(201);
    const body = (await created.json()) as { id: string; slug: string; total_parts: null; channel_ids: string[] };
    expect(body.slug).toBe("my-show");
    expect(body.total_parts).toBeNull();
    expect(body.channel_ids).toEqual([]);

    const fetched = await app.request(`/series/${body.id}`, {}, envWith(db));
    expect(fetched.status).toBe(200);

    const listed = await app.request("/series", {}, envWith(db));
    expect(((await listed.json()) as unknown[])).toHaveLength(1);

    const patched = await postJson(db, `/series/${body.id}`, { title_en: "My Show EN" }, "PATCH");
    expect(patched.status).toBe(200);
    expect(((await patched.json()) as { title_en: string }).title_en).toBe("My Show EN");

    const deleted = await app.request(`/series/${body.id}`, { method: "DELETE" }, envWith(db));
    expect(deleted.status).toBe(204);
    expect((await app.request(`/series/${body.id}`, {}, envWith(db))).status).toBe(404);
  });

  it("rejects duplicate slugs and unknown channels", async () => {
    expect((await postJson(db, "/series", { slug: "dup" })).status).toBe(201);
    const second = await postJson(db, "/series", { slug: "dup" });
    expect(second.status).toBe(409);
    expect(((await second.json()) as { error: { code: string } }).error.code).toBe("slug_taken");

    const badChannel = await postJson(db, "/series", { slug: "bad-pick", channel_ids: ["nope"] });
    expect(badChannel.status).toBe(400);
    expect(((await badChannel.json()) as { error: { code: string } }).error.code).toBe("channel_not_found");
  });

  it("resolves the channel pick and reports stale ids", async () => {
    const alpha = await createChannel(db, "Alpha", "@alpha_chan");
    const beta = await createChannel(db, "Beta", "@beta_chan");
    const created = await postJson(db, "/series", { slug: "picked", channel_ids: [alpha, beta] });
    const id = ((await created.json()) as { id: string }).id;

    const resolved = await app.request(`/series/${id}/channels`, {}, envWith(db));
    expect(resolved.status).toBe(200);
    const payload = (await resolved.json()) as { channels: { id: string }[]; missing_ids: string[] };
    expect(payload.channels.map((ch) => ch.id)).toEqual([alpha, beta]);
    expect(payload.missing_ids).toEqual([]);

    await app.request(`/channels/${beta}`, { method: "DELETE" }, envWith(db));
    const stale = (await (await app.request(`/series/${id}/channels`, {}, envWith(db))).json()) as {
      channels: { id: string }[];
      missing_ids: string[];
    };
    expect(stale.channels.map((ch) => ch.id)).toEqual([alpha]);
    expect(stale.missing_ids).toEqual([beta]);
  });

  it("attaches parts in order and guards duplicates, totals, and missing assets", async () => {
    const asset1 = await createAsset(db, "ep1.mp4");
    const asset2 = await createAsset(db, "ep2.mp4");
    const seriesId = ((await (await postJson(db, "/series", { slug: "serial", total_parts: 2 })).json()) as { id: string }).id;

    const part1 = await postJson(db, `/series/${seriesId}/parts`, { asset_id: asset1, part_index: 1, hook: "hook one" });
    expect(part1.status).toBe(201);

    const dupIndex = await postJson(db, `/series/${seriesId}/parts`, { asset_id: asset2, part_index: 1 });
    expect(dupIndex.status).toBe(409);

    const dupAsset = await postJson(db, `/series/${seriesId}/parts`, { asset_id: asset1, part_index: 2 });
    expect(dupAsset.status).toBe(409);
    expect(((await dupAsset.json()) as { error: { code: string } }).error.code).toBe("asset_already_attached");

    const beyond = await postJson(db, `/series/${seriesId}/parts`, { asset_id: asset2, part_index: 3 });
    expect(beyond.status).toBe(400);

    const missing = await postJson(db, `/series/${seriesId}/parts`, { asset_id: "ghost", part_index: 2 });
    expect(missing.status).toBe(404);

    const part2 = await postJson(db, `/series/${seriesId}/parts`, { asset_id: asset2, part_index: 2, hook: "finale" });
    expect(part2.status).toBe(201);

    const listed = (await (await app.request(`/series/${seriesId}/parts`, {}, envWith(db))).json()) as { part_index: number }[];
    expect(listed.map((p) => p.part_index)).toEqual([1, 2]);
  });

  it("refuses to shrink total_parts below attached parts", async () => {
    const asset1 = await createAsset(db, "a.mp4");
    const asset2 = await createAsset(db, "b.mp4");
    const seriesId = ((await (await postJson(db, "/series", { slug: "shrink" })).json()) as { id: string }).id;
    expect((await postJson(db, `/series/${seriesId}/parts`, { asset_id: asset1, part_index: 1 })).status).toBe(201);
    expect((await postJson(db, `/series/${seriesId}/parts`, { asset_id: asset2, part_index: 2 })).status).toBe(201);

    const shrink = await postJson(db, `/series/${seriesId}`, { total_parts: 1 }, "PATCH");
    expect(shrink.status).toBe(400);
    expect(((await shrink.json()) as { error: { code: string } }).error.code).toBe("total_below_parts");
  });

  it("renders per-part captions with teaser only before the finale", async () => {
    const asset1 = await createAsset(db, "p1.mp4");
    const asset2 = await createAsset(db, "p2.mp4");
    const seriesId = (
      (await (
        await postJson(db, "/series", {
          slug: "captioned",
          title_local: "Show",
          total_parts: 2,
          caption_template: "EP {part}/{total}: {hook} | {next_teaser} | {hashtags}",
          next_teaser_template: "next:{next_part}",
          hashtags: "#test",
        })
      ).json()) as { id: string }
    ).id;
    const part1Id = ((await (await postJson(db, `/series/${seriesId}/parts`, { asset_id: asset1, part_index: 1, hook: "hello" })).json()) as { id: string }).id;
    const part2Id = ((await (await postJson(db, `/series/${seriesId}/parts`, { asset_id: asset2, part_index: 2, hook: "bye" })).json()) as { id: string }).id;

    const first = (await (await app.request(`/series/${seriesId}/parts/${part1Id}/caption`, {}, envWith(db))).json()) as {
      caption: string;
      within_limit: boolean;
      total: number;
    };
    expect(first.caption).toContain("EP 1/2: hello");
    expect(first.caption).toContain("next:2");
    expect(first.within_limit).toBe(true);

    const last = (await (await app.request(`/series/${seriesId}/parts/${part2Id}/caption`, {}, envWith(db))).json()) as {
      caption: string;
    };
    expect(last.caption).not.toContain("next:");
  });

  it("patches part hooks, rejects index clashes, and cascades on series delete", async () => {
    const asset1 = await createAsset(db, "x1.mp4");
    const asset2 = await createAsset(db, "x2.mp4");
    const seriesId = ((await (await postJson(db, "/series", { slug: "cascade" })).json()) as { id: string }).id;
    const part1Id = ((await (await postJson(db, `/series/${seriesId}/parts`, { asset_id: asset1, part_index: 1 })).json()) as { id: string }).id;
    await postJson(db, `/series/${seriesId}/parts`, { asset_id: asset2, part_index: 2 });

    const patched = await postJson(db, `/series/${seriesId}/parts/${part1Id}`, { hook: "new hook" }, "PATCH");
    expect(patched.status).toBe(200);
    expect(((await patched.json()) as { hook: string }).hook).toBe("new hook");

    const clash = await postJson(db, `/series/${seriesId}/parts/${part1Id}`, { part_index: 2 }, "PATCH");
    expect(clash.status).toBe(409);

    expect((await app.request(`/series/${seriesId}`, { method: "DELETE" }, envWith(db))).status).toBe(204);
    expect((await app.request(`/series/${seriesId}/parts`, {}, envWith(db))).status).toBe(404);
    // The part row is gone with its series (emulated ON DELETE CASCADE).
    expect((await app.request(`/series/${seriesId}/parts/${part1Id}`, {}, envWith(db))).status).toBe(404);
  });
});
