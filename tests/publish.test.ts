import { beforeEach, describe, expect, it, vi } from "vitest";
import { app, type Env } from "../src/index";
import {
  SlotValidationError,
  isSlotDue,
  validateSlotPatch,
  zonedParts,
  type Slot,
} from "../src/publish";

/** In-memory D1 stub covering the statements assets/channels/series/parts/
 * slots/jobs emit. Tables are exposed for direct seeding (slots) and fence
 * manipulation (simulating "next day" without touching the wall clock). */
type Row = Record<string, unknown>;
type RowMap = Map<string, Row>;

function createFakeDb() {
  const assets: RowMap = new Map();
  const channels: RowMap = new Map();
  const series: RowMap = new Map();
  const parts: RowMap = new Map();
  const slots: RowMap = new Map();
  const jobs: RowMap = new Map();
  // Monotonic clock so ORDER BY created_at is deterministic under rapid inserts.
  let clock = 0;
  const now = () => new Date(Date.now() + clock++).toISOString();

  function find(table: RowMap, pred: (row: Row) => boolean): Row | undefined {
    for (const row of table.values()) {
      if (pred(row)) return row;
    }
    return undefined;
  }

  function applyUpdate(
    table: RowMap,
    q: string,
    params: Array<string | number | null>,
  ): Row | null {
    const id = String(params[params.length - 1]);
    const existing = table.get(id);
    if (!existing) return null;
    const setClause = (q.split("SET ")[1] ?? "").split(" WHERE")[0] ?? "";
    const fields = setClause.split(",").map((s) => s.trim().split(" ")[0] ?? "");
    const next = { ...existing };
    fields.forEach((field, i) => {
      if (field) next[field] = params[i] as string | number | null;
    });
    table.set(id, next);
    return next;
  }

  function sortJobs(rows: Row[]): Row[] {
    return rows.sort((a, b) => {
      const ca = String(a["created_at"]);
      const cb = String(b["created_at"]);
      if (ca !== cb) return ca < cb ? -1 : 1;
      const ia = String(a["id"]);
      const ib = String(b["id"]);
      return ia < ib ? -1 : ia > ib ? 1 : 0;
    });
  }

  const db = {
    _assets: assets,
    _channels: channels,
    _series: series,
    _parts: parts,
    _slots: slots,
    _jobs: jobs,
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
              if (q.startsWith("INSERT INTO publish_jobs")) {
                if (find(jobs, (r) => r["asset_id"] === str(1) && r["channel_id"] === str(2))) {
                  throw new Error(
                    "UNIQUE constraint failed: publish_jobs.asset_id, publish_jobs.channel_id",
                  );
                }
                const row: Row = {
                  id: str(0), asset_id: str(1), channel_id: str(2),
                  chat_id_snapshot: str(3), caption: str(4), state: "scheduled",
                  external_id: null, external_url: null, attempts: 0, last_error: null,
                  created_at: now(), updated_at: now(),
                };
                jobs.set(row["id"] as string, row);
                return (row as unknown) as T;
              }
              // --- UPDATES (RETURNING) ---
              if (q.startsWith("UPDATE series_parts")) {
                return (applyUpdate(parts, q, params) as unknown) as T;
              }
              if (q.startsWith("UPDATE series SET")) {
                return (applyUpdate(series, q, params) as unknown) as T;
              }
              if (q.startsWith("UPDATE publish_jobs SET")) {
                return (applyUpdate(jobs, q, params) as unknown) as T;
              }
              if (q.startsWith("UPDATE schedule_slots SET")) {
                return (applyUpdate(slots, q, params) as unknown) as T;
              }
              // --- SELECTS: stats ---
              if (q.startsWith("SELECT COUNT(*)")) {
                const rows = [...parts.values()].filter((r) => r["series_id"] === str(0));
                const max = rows.reduce<number | null>(
                  (m, r) => Math.max(m ?? 0, r["part_index"] as number) || null,
                  null,
                );
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
              // --- SELECTS: jobs ---
              if (q.includes("FROM publish_jobs")) {
                if (q.includes("WHERE asset_id = ? AND channel_id = ?")) {
                  return ((find(jobs, (r) => r["asset_id"] === str(0) && r["channel_id"] === str(1)) ?? null) as unknown) as T | null;
                }
                if (q.includes("WHERE id = ?")) {
                  return ((jobs.get(str(0)) ?? null) as unknown) as T | null;
                }
              }
              // --- SELECTS: slots ---
              if (q.includes("FROM schedule_slots") && q.includes("WHERE id = ?")) {
                return ((slots.get(str(0)) ?? null) as unknown) as T | null;
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
              if (q.includes("FROM publish_jobs")) {
                let rows = [...jobs.values()];
                if (q.includes("WHERE channel_id = ?")) {
                  rows = rows.filter((r) => r["channel_id"] === String(params[0]));
                }
                if (q.includes("AND state = 'published'")) {
                  rows = rows.filter((r) => r["state"] === "published");
                }
                if (q.includes("WHERE state = ?")) {
                  rows = rows.filter((r) => r["state"] === String(params[0]));
                }
                rows = sortJobs(rows);
                if (q.includes("LIMIT ?")) {
                  rows = rows.slice(0, Number(params[params.length - 1]));
                }
                if (q.startsWith("SELECT asset_id")) {
                  return { results: (rows.map((r) => ({ asset_id: r["asset_id"] })) as unknown) as T[] };
                }
                return { results: (rows as unknown) as T[] };
              }
              if (q.includes("FROM series_parts")) {
                const rows = [...parts.values()]
                  .filter((r) => r["series_id"] === String(params[0]))
                  .sort((a, b) => (a["part_index"] as number) - (b["part_index"] as number));
                return { results: (rows as unknown) as T[] };
              }
              if (q.includes("FROM series")) {
                return { results: ([...series.values()] as unknown) as T[] };
              }
              if (q.includes("FROM telegram_channels")) {
                return { results: ([...channels.values()] as unknown) as T[] };
              }
              if (q.includes("FROM schedule_slots")) {
                const rows = [...slots.values()].sort((a, b) =>
                  (a["hour"] as number) - (b["hour"] as number) ||
                  (a["minute"] as number) - (b["minute"] as number) ||
                  (String(a["id"]) < String(b["id"]) ? -1 : 1),
                );
                return { results: (rows as unknown) as T[] };
              }
              return { results: [] as T[] };
            },
            run: async () => {
              if (q.startsWith("UPDATE schedule_slots SET")) {
                return { meta: { changes: applyUpdate(slots, q, params) ? 1 : 0 } };
              }
              if (q.startsWith("UPDATE publish_jobs SET")) {
                return { meta: { changes: applyUpdate(jobs, q, params) ? 1 : 0 } };
              }
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
        // No-bind .all(): listSlots / listSeries / listChannels.
        all: async <T>(): Promise<{ results: T[] }> => {
          if (q.includes("FROM schedule_slots")) {
            const rows = [...slots.values()].sort((a, b) =>
              (a["hour"] as number) - (b["hour"] as number) ||
              (a["minute"] as number) - (b["minute"] as number) ||
              (String(a["id"]) < String(b["id"]) ? -1 : 1),
            );
            return { results: (rows as unknown) as T[] };
          }
          if (q.includes("FROM series_parts")) {
            const rows = [...parts.values()].sort(
              (a, b) => (a["part_index"] as number) - (b["part_index"] as number),
            );
            return { results: (rows as unknown) as T[] };
          }
          if (q.includes("FROM series")) {
            return { results: ([...series.values()] as unknown) as T[] };
          }
          if (q.includes("FROM telegram_channels")) {
            return { results: ([...channels.values()] as unknown) as T[] };
          }
          if (q.includes("FROM publish_jobs")) {
            return { results: (sortJobs([...jobs.values()]) as unknown) as T[] };
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

function envWith(db: FakeDb, overrides: Partial<Env> = {}): Env {
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
    R2_PUBLIC_BASE_URL: "https://media.example.test",
    TELEGRAM_BOT_TOKEN: "test-token",
    ...overrides,
  };
}

async function postJson(db: FakeDb, path: string, payload: unknown, method = "POST", env?: Env) {
  return app.request(
    path,
    { method, headers: { "content-type": "application/json" }, body: JSON.stringify(payload) },
    env ?? envWith(db),
  );
}

async function json<T>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

async function createChannel(
  db: FakeDb,
  label: string,
  chat_id: string,
  extra: Record<string, unknown> = {},
): Promise<string> {
  const res = await postJson(db, "/channels", { label, chat_id, ...extra });
  expect(res.status).toBe(201);
  return (await json<{ id: string }>(res)).id;
}

async function createAsset(db: FakeDb, filename: string): Promise<{ id: string; storage_key: string }> {
  const intent = await postJson(db, "/assets/upload-url", { filename, size_bytes: 1024 });
  expect(intent.status).toBe(200);
  const { storage_key } = await json<{ storage_key: string }>(intent);
  const registered = await postJson(db, "/assets", { storage_key });
  expect(registered.status).toBe(201);
  const { id } = await json<{ id: string }>(registered);
  return { id, storage_key };
}

async function createSeries(
  db: FakeDb,
  payload: Record<string, unknown>,
): Promise<{ id: string; slug: string }> {
  const res = await postJson(db, "/series", payload);
  expect(res.status).toBe(201);
  return await json<{ id: string; slug: string }>(res);
}

async function attachPart(db: FakeDb, seriesId: string, assetId: string, partIndex: number, hook = "") {
  const res = await postJson(db, `/series/${seriesId}/parts`, {
    asset_id: assetId,
    part_index: partIndex,
    hook,
  });
  expect(res.status).toBe(201);
  return await json<{ id: string }>(res);
}

function seedSlot(
  db: FakeDb,
  slot: {
    id: string;
    hour?: number;
    minute?: number;
    timezone?: string;
    enabled?: boolean;
    label?: string;
    last_fired_on?: string | null;
  },
) {
  db._slots.set(slot.id, {
    id: slot.id,
    label: slot.label ?? slot.id,
    hour: slot.hour ?? 0,
    minute: slot.minute ?? 0,
    timezone: slot.timezone ?? "UTC",
    enabled: (slot.enabled ?? true) ? 1 : 0,
    last_fired_on: slot.last_fired_on ?? null,
    created_at: new Date().toISOString(),
  });
}

interface SentCall {
  chat_id: string;
  video: string;
  caption: string;
  protect_content?: boolean;
}

function telegramSuccess(calls: SentCall[], messageId: { next: number }) {
  return vi.fn(async (_url: unknown, init?: { body?: string }) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as {
      chat_id: string;
      video: string;
      caption?: string;
      protect_content?: boolean;
    };
    calls.push({ chat_id: body.chat_id, video: body.video, caption: body.caption ?? "", protect_content: body.protect_content });
    messageId.next += 1;
    return new Response(
      JSON.stringify({ ok: true, result: { message_id: messageId.next, chat: { id: body.chat_id } } }),
      { headers: { "content-type": "application/json" } },
    );
  });
}

function telegramFailure(
  calls: SentCall[],
  status: number,
  payload: Record<string, unknown>,
) {
  return vi.fn(async (_url: unknown, init?: { body?: string }) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as {
      chat_id: string;
      video: string;
      caption?: string;
    };
    calls.push({ chat_id: body.chat_id, video: body.video, caption: body.caption ?? "" });
    return new Response(JSON.stringify(payload), {
      status,
      headers: { "content-type": "application/json" },
    });
  });
}

const RATE_LIMITED = {
  ok: false,
  description: "Too Many Requests: retry after 5",
  error_code: 429,
  parameters: { retry_after: 5 },
};

const FORBIDDEN = {
  ok: false,
  description: "Forbidden: bot was kicked from the channel",
  error_code: 403,
};

interface TickSummary {
  fired_slots: string[];
  jobs_created: number;
  published: number;
  failed: number;
  deferred: number;
  errors: string[];
}

interface JobView {
  id: string;
  asset_id: string;
  channel_id: string | null;
  chat_id_snapshot: string;
  caption: string;
  state: string;
  external_id: string | null;
  attempts: number;
  last_error: string | null;
  storage_key: string | null;
  series: { id: string; slug: string } | null;
  part_index: number | null;
}

describe("slot due (unit)", () => {
  it("resolves the date and wall time in the slot timezone", () => {
    // 2026-10-16 05:30 UTC == 12:30 in Bangkok (UTC+7, no DST).
    expect(zonedParts(Date.UTC(2026, 9, 16, 5, 30), "Asia/Bangkok")).toEqual({
      date: "2026-10-16",
      hour: 12,
      minute: 30,
    });
  });

  it("fires once the slot time passes, at the exact minute", () => {
    const base: Slot = {
      id: "s", label: "Lunch", hour: 12, minute: 30, timezone: "Asia/Bangkok",
      enabled: true, last_fired_on: null, created_at: "",
    };
    expect(isSlotDue(base, Date.UTC(2026, 9, 16, 5, 30))).toBe(true);
    expect(isSlotDue({ ...base, minute: 31 }, Date.UTC(2026, 9, 16, 5, 30))).toBe(false);
    expect(isSlotDue({ ...base, hour: 13 }, Date.UTC(2026, 9, 16, 5, 30))).toBe(false);
  });

  it("enforces at-most-once per slot per day in the slot timezone", () => {
    const base: Slot = {
      id: "s", label: "Lunch", hour: 12, minute: 0, timezone: "Asia/Bangkok",
      enabled: true, last_fired_on: null, created_at: "",
    };
    const now = Date.UTC(2026, 9, 16, 5, 30);
    expect(isSlotDue(base, now)).toBe(true);
    expect(isSlotDue({ ...base, last_fired_on: "2026-10-16" }, now)).toBe(false);
    expect(isSlotDue({ ...base, last_fired_on: "2026-10-15" }, now)).toBe(true);
    expect(isSlotDue({ ...base, enabled: false }, now)).toBe(false);
  });

  it("uses the slot timezone, never the UTC date, for the day fence", () => {
    // 2026-06-15 02:30 UTC == 2026-06-14 22:30 in New York (UTC-4).
    const now = Date.UTC(2026, 5, 15, 2, 30);
    expect(zonedParts(now, "America/New_York")).toEqual({ date: "2026-06-14", hour: 22, minute: 30 });
    const base: Slot = {
      id: "s", label: "Late", hour: 22, minute: 0, timezone: "America/New_York",
      enabled: true, last_fired_on: null, created_at: "",
    };
    expect(isSlotDue(base, now)).toBe(true);
    // Fired "today" in New York — even though the UTC date is already the 15th.
    expect(isSlotDue({ ...base, last_fired_on: "2026-06-14" }, now)).toBe(false);
    expect(isSlotDue({ ...base, last_fired_on: "2026-06-15" }, now)).toBe(true);
  });

  it("validates slot patches", () => {
    expect(validateSlotPatch({ hour: 18 })).toEqual({ hour: 18 });
    expect(() => validateSlotPatch({})).toThrowError(SlotValidationError);
    expect(() => validateSlotPatch({ hour: 24 })).toThrowError(SlotValidationError);
    expect(() => validateSlotPatch({ minute: 60 })).toThrowError(SlotValidationError);
    expect(() => validateSlotPatch({ timezone: "Mars/Olympus" })).toThrowError(SlotValidationError);
    expect(() => validateSlotPatch({ enabled: "yes" })).toThrowError(SlotValidationError);
  });
});

describe("tick release routes", () => {
  let db: FakeDb;

  beforeEach(() => {
    db = createFakeDb();
    vi.unstubAllGlobals();
  });

  async function setupOnePartSeries(opts: { totalParts?: number } = {}) {
    seedSlot(db, { id: "slot-1", hour: 0, minute: 0, timezone: "UTC" });
    const channelId = await createChannel(db, "News", "@newschan", { protect_content: true });
    const asset = await createAsset(db, "ep1.mp4");
    const series = await createSeries(db, {
      slug: "my-show",
      title_local: "Show",
      ...(opts.totalParts === undefined ? {} : { total_parts: opts.totalParts }),
      channel_ids: [channelId],
    });
    await attachPart(db, series.id, asset.id, 1, "hello hook");
    return { channelId, asset, series };
  }

  it("ticks a due slot: creates one job, publishes it, marks the slot", async () => {
    const { asset, series } = await setupOnePartSeries();
    const calls: SentCall[] = [];
    vi.stubGlobal("fetch", telegramSuccess(calls, { next: 100 }));

    const tick = await app.request("/tick", { method: "POST" }, envWith(db));
    expect(tick.status).toBe(200);
    const summary = await json<TickSummary>(tick);
    expect(summary).toEqual({
      fired_slots: ["slot-1"],
      jobs_created: 1,
      published: 1,
      failed: 0,
      deferred: 0,
      errors: [],
    });

    // One sendVideo with the frozen chat, the public R2 URL, and flags.
    expect(calls).toHaveLength(1);
    expect(calls[0]!.chat_id).toBe("@newschan");
    expect(calls[0]!.video).toBe(`https://media.example.test/${asset.storage_key}`);
    expect(calls[0]!.caption).toContain("hello hook");
    expect(calls[0]!.protect_content).toBe(true);

    const jobsRes = await app.request("/jobs", {}, envWith(db));
    expect(jobsRes.status).toBe(200);
    const jobs = await json<JobView[]>(jobsRes);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.state).toBe("published");
    expect(jobs[0]!.attempts).toBe(1);
    expect(jobs[0]!.external_id).toBe("101");
    expect(jobs[0]!.storage_key).toBe(asset.storage_key);
    expect(jobs[0]!.series).toEqual({ id: series.id, slug: "my-show" });
    expect(jobs[0]!.part_index).toBe(1);

    const slotsRes = await app.request("/slots", {}, envWith(db));
    const slots = await json<Slot[]>(slotsRes);
    expect(slots[0]!.last_fired_on).toBe(zonedParts(Date.now(), "UTC").date);
  });

  it("re-ticks the same day as a no-op", async () => {
    await setupOnePartSeries();
    vi.stubGlobal("fetch", telegramSuccess([], { next: 1 }));
    expect((await json<TickSummary>(await app.request("/tick", { method: "POST" }, envWith(db)))).fired_slots).toEqual(["slot-1"]);

    const calls: SentCall[] = [];
    vi.stubGlobal("fetch", telegramSuccess(calls, { next: 500 }));
    const second = await app.request("/tick", { method: "POST" }, envWith(db));
    expect(await json<TickSummary>(second)).toEqual({
      fired_slots: [],
      jobs_created: 0,
      published: 0,
      failed: 0,
      deferred: 0,
      errors: [],
    });
    expect(calls).toHaveLength(0);
  });

  it("returns zeros when no slot is due", async () => {
    const res = await app.request("/tick", { method: "POST" }, envWith(db));
    expect(await json<TickSummary>(res)).toEqual({
      fired_slots: [],
      jobs_created: 0,
      published: 0,
      failed: 0,
      deferred: 0,
      errors: [],
    });
  });

  it("keeps a rate-limited job scheduled and retries it on a later tick", async () => {
    await setupOnePartSeries();
    vi.stubGlobal("fetch", telegramFailure([], 429, RATE_LIMITED));

    const first = await json<TickSummary>(await app.request("/tick", { method: "POST" }, envWith(db)));
    expect(first.jobs_created).toBe(1);
    expect(first.published).toBe(0);
    expect(first.deferred).toBe(1);
    expect(first.failed).toBe(0);
    expect(first.errors).toHaveLength(1);

    const jobs = await json<JobView[]>(await app.request("/jobs", {}, envWith(db)));
    expect(jobs[0]!.state).toBe("scheduled");
    expect(jobs[0]!.attempts).toBe(1);
    expect(jobs[0]!.last_error).toBeTruthy();

    // Next day: the same scheduled row is re-attempted, not duplicated.
    db._slots.get("slot-1")!["last_fired_on"] = "2000-01-01";
    vi.stubGlobal("fetch", telegramSuccess([], { next: 200 }));
    const second = await json<TickSummary>(await app.request("/tick", { method: "POST" }, envWith(db)));
    expect(second.jobs_created).toBe(0);
    expect(second.published).toBe(1);
    expect(second.deferred).toBe(0);
    const after = await json<JobView[]>(await app.request("/jobs", {}, envWith(db)));
    expect(after).toHaveLength(1);
    expect(after[0]!.state).toBe("published");
    expect(after[0]!.attempts).toBe(2);
  });

  it("marks forbidden jobs failed and republishes them via retry", async () => {
    await setupOnePartSeries();
    vi.stubGlobal("fetch", telegramFailure([], 403, FORBIDDEN));

    const first = await json<TickSummary>(await app.request("/tick", { method: "POST" }, envWith(db)));
    expect(first.failed).toBe(1);
    expect(first.published).toBe(0);
    const jobs = await json<JobView[]>(await app.request("/jobs", {}, envWith(db)));
    expect(jobs[0]!.state).toBe("failed");
    expect(jobs[0]!.attempts).toBe(1);
    const jobId = jobs[0]!.id;

    // The tick never flips failed rows on its own: next day changes nothing.
    db._slots.get("slot-1")!["last_fired_on"] = "2000-01-01";
    vi.stubGlobal("fetch", telegramSuccess([], { next: 300 }));
    const retick = await json<TickSummary>(await app.request("/tick", { method: "POST" }, envWith(db)));
    expect(retick.published).toBe(0);
    expect(retick.failed).toBe(0);

    const retry = await app.request(`/jobs/${jobId}/retry`, { method: "POST" }, envWith(db));
    expect(retry.status).toBe(200);
    const retried = await json<JobView>(retry);
    expect(retried.state).toBe("published");
    expect(retried.attempts).toBe(2);
    expect(retried.external_id).toBe("301");

    // Retrying a non-failed job is a 409; unknown ids are 404.
    const again = await app.request(`/jobs/${jobId}/retry`, { method: "POST" }, envWith(db));
    expect(again.status).toBe(409);
    expect((await json<{ error: { code: string } }>(again)).error.code).toBe("job_not_failed");
    const missing = await app.request("/jobs/ghost/retry", { method: "POST" }, envWith(db));
    expect(missing.status).toBe(404);
  });

  it("defers without crashing when the bot token is missing", async () => {
    await setupOnePartSeries();
    vi.stubGlobal("fetch", telegramSuccess([], { next: 1 }));
    const summary = await json<TickSummary>(
      await app.request("/tick", { method: "POST" }, envWith(db, { TELEGRAM_BOT_TOKEN: "" })),
    );
    expect(summary.fired_slots).toEqual(["slot-1"]);
    expect(summary.jobs_created).toBe(1);
    expect(summary.deferred).toBe(1);
    expect(summary.published).toBe(0);
    const jobs = await json<JobView[]>(await app.request("/jobs", {}, envWith(db)));
    expect(jobs[0]!.state).toBe("scheduled");
    expect(jobs[0]!.last_error).toContain("TELEGRAM_BOT_TOKEN");
  });

  it("defers without crashing when the public base URL is missing", async () => {
    await setupOnePartSeries();
    vi.stubGlobal("fetch", telegramSuccess([], { next: 1 }));
    const summary = await json<TickSummary>(
      await app.request("/tick", { method: "POST" }, envWith(db, { R2_PUBLIC_BASE_URL: "" })),
    );
    expect(summary.deferred).toBe(1);
    expect(summary.published).toBe(0);
    const jobs = await json<JobView[]>(await app.request("/jobs", {}, envWith(db)));
    expect(jobs[0]!.state).toBe("scheduled");
    expect(jobs[0]!.last_error).toContain("R2_PUBLIC_BASE_URL");
  });

  it("keeps per-channel progress independent", async () => {
    seedSlot(db, { id: "slot-1", hour: 0, minute: 0, timezone: "UTC" });
    const channelA = await createChannel(db, "Alpha", "@alpha_chan");
    const channelB = await createChannel(db, "Beta", "@beta_chan");
    const asset1 = await createAsset(db, "ep1.mp4");
    const asset2 = await createAsset(db, "ep2.mp4");
    const series = await createSeries(db, {
      slug: "serial",
      title_local: "Serial",
      total_parts: 2,
      channel_ids: [channelA, channelB],
    });
    await attachPart(db, series.id, asset1.id, 1, "first");
    await attachPart(db, series.id, asset2.id, 2, "second");

    // Tick 1: A publishes part 1, B is rate-limited (stays scheduled).
    const betaId = channelB;
    const calls: SentCall[] = [];
    const messageId = { next: 400 };
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: unknown, init?: { body?: string }) => {
        const body = JSON.parse(String(init?.body ?? "{}")) as { chat_id: string; video: string; caption?: string };
        calls.push({ chat_id: body.chat_id, video: body.video, caption: body.caption ?? "" });
        if (body.chat_id === "@beta_chan") {
          return new Response(JSON.stringify(RATE_LIMITED), {
            status: 429,
            headers: { "content-type": "application/json" },
          });
        }
        messageId.next += 1;
        return new Response(
          JSON.stringify({ ok: true, result: { message_id: messageId.next, chat: { id: body.chat_id } } }),
          { headers: { "content-type": "application/json" } },
        );
      }),
    );
    const first = await json<TickSummary>(await app.request("/tick", { method: "POST" }, envWith(db)));
    expect(first.jobs_created).toBe(2);
    expect(first.published).toBe(1);
    expect(first.deferred).toBe(1);

    // Tick 2 (next day, deliveries healthy): A moves on to part 2 (new job),
    // B still gets part 1 — not 2.
    db._slots.get("slot-1")!["last_fired_on"] = "2000-01-01";
    vi.stubGlobal("fetch", telegramSuccess(calls, messageId));
    const second = await json<TickSummary>(await app.request("/tick", { method: "POST" }, envWith(db)));
    expect(second.jobs_created).toBe(1);
    expect(second.published).toBe(2);

    const toA = calls.filter((c) => c.chat_id === "@alpha_chan").map((c) => c.video);
    const toB = calls.filter((c) => c.chat_id === "@beta_chan").map((c) => c.video);
    expect(toA).toEqual([
      `https://media.example.test/${asset1.storage_key}`,
      `https://media.example.test/${asset2.storage_key}`,
    ]);
    expect(toB).toEqual([
      `https://media.example.test/${asset1.storage_key}`,
      `https://media.example.test/${asset1.storage_key}`,
    ]);

    const jobsB = await json<JobView[]>(
      await app.request(`/jobs?channel_id=${betaId}`, {}, envWith(db)),
    );
    expect(jobsB).toHaveLength(1);
    expect(jobsB[0]!.part_index).toBe(1);
    expect(jobsB[0]!.state).toBe("published");
  });

  it("lists and retunes slots", async () => {
    seedSlot(db, { id: "slot-evening", hour: 18, minute: 0, timezone: "UTC", label: "Evening" });
    seedSlot(db, { id: "slot-lunch", hour: 12, minute: 0, timezone: "UTC", label: "Lunch" });
    seedSlot(db, { id: "slot-night", hour: 21, minute: 0, timezone: "UTC", label: "Night" });

    const listed = await json<Slot[]>(await app.request("/slots", {}, envWith(db)));
    expect(listed.map((s) => s.id)).toEqual(["slot-lunch", "slot-evening", "slot-night"]);

    const patched = await postJson(
      db,
      "/slots/slot-lunch",
      { hour: 13, minute: 30, timezone: "Asia/Bangkok", label: "Lunch rush", enabled: false },
      "PATCH",
    );
    expect(patched.status).toBe(200);
    const slot = await json<Slot>(patched);
    expect(slot.hour).toBe(13);
    expect(slot.minute).toBe(30);
    expect(slot.timezone).toBe("Asia/Bangkok");
    expect(slot.label).toBe("Lunch rush");
    expect(slot.enabled).toBe(false);

    const badHour = await postJson(db, "/slots/slot-lunch", { hour: 24 }, "PATCH");
    expect(badHour.status).toBe(400);
    expect((await json<{ error: { code: string } }>(badHour)).error.code).toBe("invalid_hour");

    const badTz = await postJson(db, "/slots/slot-lunch", { timezone: "Nope/Zone" }, "PATCH");
    expect(badTz.status).toBe(400);
    expect((await json<{ error: { code: string } }>(badTz)).error.code).toBe("invalid_timezone");

    const empty = await postJson(db, "/slots/slot-lunch", {}, "PATCH");
    expect(empty.status).toBe(400);

    const missing = await postJson(db, "/slots/ghost", { hour: 9 }, "PATCH");
    expect(missing.status).toBe(404);
    expect((await json<{ error: { code: string } }>(missing)).error.code).toBe("slot_not_found");
  });

  it("ignores disabled slots on tick", async () => {
    seedSlot(db, { id: "slot-off", hour: 0, minute: 0, timezone: "UTC", enabled: false });
    const summary = await json<TickSummary>(await app.request("/tick", { method: "POST" }, envWith(db)));
    expect(summary.fired_slots).toEqual([]);
  });

  it("filters the job list by state, series, channel, and limit", async () => {
    seedSlot(db, { id: "slot-1", hour: 0, minute: 0, timezone: "UTC" });
    const channelA = await createChannel(db, "Alpha", "@alpha_chan");
    const channelB = await createChannel(db, "Beta", "@beta_chan");
    const asset = await createAsset(db, "ep1.mp4");
    const series = await createSeries(db, {
      slug: "filter-me",
      title_local: "Filter",
      total_parts: 1,
      channel_ids: [channelA, channelB],
    });
    await attachPart(db, series.id, asset.id, 1, "hook");
    vi.stubGlobal("fetch", telegramSuccess([], { next: 600 }));
    const summary = await json<TickSummary>(await app.request("/tick", { method: "POST" }, envWith(db)));
    expect(summary.published).toBe(2);

    const all = await json<JobView[]>(await app.request("/jobs", {}, envWith(db)));
    expect(all).toHaveLength(2);

    const published = await json<JobView[]>(await app.request("/jobs?state=published", {}, envWith(db)));
    expect(published).toHaveLength(2);
    const failed = await json<JobView[]>(await app.request("/jobs?state=failed", {}, envWith(db)));
    expect(failed).toHaveLength(0);

    const bySeries = await json<JobView[]>(
      await app.request(`/jobs?series_id=${series.id}`, {}, envWith(db)),
    );
    expect(bySeries).toHaveLength(2);

    const byChannel = await json<JobView[]>(
      await app.request(`/jobs?channel_id=${channelA}`, {}, envWith(db)),
    );
    expect(byChannel).toHaveLength(1);
    expect(byChannel[0]!.channel_id).toBe(channelA);

    const limited = await json<JobView[]>(await app.request("/jobs?limit=1", {}, envWith(db)));
    expect(limited).toHaveLength(1);

    const badState = await app.request("/jobs?state=bogus", {}, envWith(db));
    expect(badState.status).toBe(400);
    expect((await json<{ error: { code: string } }>(badState)).error.code).toBe("invalid_state");

    const badLimit = await app.request("/jobs?limit=0", {}, envWith(db));
    expect(badLimit.status).toBe(400);

    const capped = await app.request("/jobs?limit=500", {}, envWith(db));
    expect(capped.status).toBe(200);
    expect((await json<JobView[]>(capped)).length).toBe(2);
  });
});
