import { beforeEach, describe, expect, it, vi } from "vitest";
import { app, type Env } from "../src/index";
import {
  ChannelValidationError,
  validateChannelCreate,
  validateChannelPatch,
  validateChatId,
} from "../src/channels";

/** Minimal in-memory D1 stub covering exactly the statements channels.ts emits. */
interface FakeRow {
  id: string;
  label: string;
  chat_id: string;
  is_public: number;
  protect_content: number;
  enabled: number;
  created_at: string;
}

function createFakeDb() {
  const rows = new Map<string, FakeRow>();
  const now = () => new Date().toISOString();

  function findByChatId(chatId: string): FakeRow | undefined {
    for (const row of rows.values()) {
      if (row.chat_id === chatId) return row;
    }
    return undefined;
  }

  const db = {
    _rows: rows,
    prepare(sql: string) {
      const normalized = sql.replace(/\s+/g, " ").trim();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const stmt: any = {
        bind(...params: Array<string | number>) {
          return {
            first: async <T>(): Promise<T | null> => {
              if (normalized.startsWith("SELECT") && normalized.includes("WHERE id = ?")) {
                return ((rows.get(String(params[0])) ?? null) as unknown) as T | null;
              }
              if (normalized.startsWith("INSERT")) {
                const [id, label, chat_id, is_public, protect_content, enabled] = params as [
                  string,
                  string,
                  string,
                  number,
                  number,
                  number,
                ];
                if (findByChatId(String(chat_id))) {
                  throw new Error("UNIQUE constraint failed: telegram_channels.chat_id");
                }
                const row: FakeRow = {
                  id: String(id),
                  label: String(label),
                  chat_id: String(chat_id),
                  is_public: Number(is_public),
                  protect_content: Number(protect_content),
                  enabled: Number(enabled),
                  created_at: now(),
                };
                rows.set(row.id, row);
                return (row as unknown) as T;
              }
              if (normalized.startsWith("UPDATE")) {
                const id = String(params[params.length - 1]);
                const existing = rows.get(id);
                if (!existing) return null as unknown as T;
                const setClause = normalized.split("SET ")[1]?.split(" WHERE")[0] ?? "";
                const fields = setClause.split(",").map((s) => s.trim().split(" ")[0]);
                const values = params.slice(0, -1);
                const next: FakeRow = { ...existing };
                fields.forEach((field, i) => {
                  const value = values[i] as string | number;
                  if (field === "label") next.label = String(value);
                  if (field === "chat_id") next.chat_id = String(value);
                  if (field === "is_public") next.is_public = Number(value);
                  if (field === "protect_content") next.protect_content = Number(value);
                  if (field === "enabled") next.enabled = Number(value);
                });
                const clash = findByChatId(next.chat_id);
                if (clash && clash.id !== id) {
                  throw new Error("UNIQUE constraint failed: telegram_channels.chat_id");
                }
                rows.set(id, next);
                return (next as unknown) as T;
              }
              return null as unknown as T;
            },
            all: async <T>(): Promise<{ results: T[] }> => {
              const all = [...rows.values()].sort((a, b) =>
                a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : 0,
              );
              return { results: (all as unknown) as T[] };
            },
            run: async () => {
              if (normalized.startsWith("DELETE")) {
                const id = String(params[0]);
                const deleted = rows.delete(id);
                return { meta: { changes: deleted ? 1 : 0 } };
              }
              return { meta: { changes: 0 } };
            },
          };
        },
        first: async <T>(): Promise<T | null> => null as unknown as T | null,
        all: async <T>(): Promise<{ results: T[] }> => {
          const all = [...rows.values()];
          return { results: (all as unknown) as T[] };
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
    MEDIA: {} as unknown as R2Bucket,
    R2_ACCOUNT_ID: "",
    R2_BUCKET: "",
    R2_ACCESS_KEY_ID: "",
    R2_SECRET_ACCESS_KEY: "",
    R2_PUBLIC_BASE_URL: "",
    TELEGRAM_BOT_TOKEN: "test-token",
    ...overrides,
  };
}

describe("channel validation", () => {
  it("accepts a public @handle and a private numeric id", () => {
    expect(validateChatId("@mychannel").trim()).toBe("@mychannel");
    expect(validateChatId("-1001234567890")).toBe("-1001234567890");
  });

  it("rejects garbage chat_ids", () => {
    expect(() => validateChatId("not a chat!!")).toThrowError(ChannelValidationError);
    expect(() => validateChatId("@ab")).toThrowError(ChannelValidationError);
    expect(() => validateChatId("")).toThrowError(ChannelValidationError);
  });

  it("requires a label and boolean flags", () => {
    expect(() =>
      validateChannelCreate({ label: "  ", chat_id: "@mychannel" }),
    ).toThrowError(ChannelValidationError);
    expect(() =>
      validateChannelCreate({ label: "News", chat_id: "@mychannel", enabled: "yes" }),
    ).toThrowError(ChannelValidationError);
  });

  it("rejects empty patches", () => {
    expect(() => validateChannelPatch({})).toThrowError(ChannelValidationError);
  });

  it("accepts a partial patch", () => {
    expect(validateChannelPatch({ enabled: false })).toEqual({ enabled: false });
  });
});

describe("channels routes", () => {
  let db: FakeDb;

  beforeEach(() => {
    db = createFakeDb();
    vi.unstubAllGlobals();
  });

  async function createChannel(payload: Record<string, unknown>) {
    return app.request("/channels", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) }, envWith(db));
  }

  it("CRUD round-trips: create → get → list → patch → delete", async () => {
    const created = await createChannel({ label: "News", chat_id: "@newschannel" });
    expect(created.status).toBe(201);
    const body = (await created.json()) as { id: string; chat_id: string; enabled: boolean };
    expect(body.chat_id).toBe("@newschannel");
    expect(body.enabled).toBe(true);

    const fetched = await app.request(`/channels/${body.id}`, {}, envWith(db));
    expect(fetched.status).toBe(200);

    const listed = await app.request("/channels", {}, envWith(db));
    const listBody = (await listed.json()) as unknown[];
    expect(listBody).toHaveLength(1);

    const patched = await app.request(
      `/channels/${body.id}`,
      { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ enabled: false }) },
      envWith(db),
    );
    expect(patched.status).toBe(200);
    expect(((await patched.json()) as { enabled: boolean }).enabled).toBe(false);

    const deleted = await app.request(`/channels/${body.id}`, { method: "DELETE" }, envWith(db));
    expect(deleted.status).toBe(204);

    const missing = await app.request(`/channels/${body.id}`, {}, envWith(db));
    expect(missing.status).toBe(404);
  });

  it("returns 409 on duplicate chat_id", async () => {
    expect((await createChannel({ label: "A", chat_id: "@dupchan" })).status).toBe(201);
    const second = await createChannel({ label: "B", chat_id: "@dupchan" });
    expect(second.status).toBe(409);
    expect(((await second.json()) as { error: { code: string } }).error.code).toBe("chat_id_taken");
  });

  it("returns 400 on invalid chat_id and empty patch", async () => {
    const bad = await createChannel({ label: "A", chat_id: "nope!!" });
    expect(bad.status).toBe(400);

    const created = await createChannel({ label: "A", chat_id: "@patchme" });
    const id = ((await created.json()) as { id: string }).id;
    const emptyPatch = await app.request(
      `/channels/${id}`,
      { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({}) },
      envWith(db),
    );
    expect(emptyPatch.status).toBe(400);
  });

  it("verify reports 503 without a bot token", async () => {
    const created = await createChannel({ label: "A", chat_id: "@verifyme" });
    const id = ((await created.json()) as { id: string }).id;
    const res = await app.request(`/channels/${id}/verify`, { method: "POST" }, envWith(db, { TELEGRAM_BOT_TOKEN: "" }));
    expect(res.status).toBe(503);
  });

  it("verify returns the chat on getChat success", async () => {
    const created = await createChannel({ label: "A", chat_id: "@verifyok" });
    const id = ((await created.json()) as { id: string }).id;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify({ ok: true, result: { id: -1001, type: "channel", title: "A" } }), {
          headers: { "content-type": "application/json" },
        }),
      ),
    );
    const res = await app.request(`/channels/${id}/verify`, { method: "POST" }, envWith(db));
    expect(res.status).toBe(200);
    const payload = (await res.json()) as { ok: boolean; chat: { title: string } };
    expect(payload.ok).toBe(true);
    expect(payload.chat.title).toBe("A");
  });

  it("verify maps Telegram 403 to HTTP 403", async () => {
    const created = await createChannel({ label: "A", chat_id: "@verifybad" });
    const id = ((await created.json()) as { id: string }).id;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify({ ok: false, description: "Forbidden: bot is not a member", error_code: 403 }), {
          status: 403,
          headers: { "content-type": "application/json" },
        }),
      ),
    );
    const res = await app.request(`/channels/${id}/verify`, { method: "POST" }, envWith(db));
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("telegram_forbidden");
  });
});
