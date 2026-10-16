import { describe, expect, it, vi } from "vitest";
import {
  TELEGRAM_CAPTION_LIMIT,
  TelegramApiError,
  getChat,
  sendVideo,
  telegramMethodUrl,
} from "../src/telegram";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("telegramMethodUrl", () => {
  it("targets the bot-scoped method path", () => {
    expect(telegramMethodUrl("TOK", "sendVideo")).toBe("https://api.telegram.org/botTOK/sendVideo");
  });
});

describe("sendVideo", () => {
  it("POSTs JSON and returns the message on ok:true", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ ok: true, result: { message_id: 7, chat: { id: -100123, type: "channel" } } }),
    );
    const msg = await sendVideo(
      "TOK",
      { chat_id: "@mychan", video: "https://cdn.example/v.mp4", caption: "hi" },
      fetchImpl as unknown as typeof fetch,
    );
    expect(msg.message_id).toBe(7);
    expect(fetchImpl).toHaveBeenCalledOnce();
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.telegram.org/botTOK/sendVideo");
    expect(JSON.parse(init.body as string)).toMatchObject({ chat_id: "@mychan" });
  });

  it("rejects oversize captions without hitting the network", async () => {
    const fetchImpl = vi.fn();
    await expect(
      sendVideo(
        "TOK",
        { chat_id: "@c", video: "https://cdn.example/v.mp4", caption: "x".repeat(TELEGRAM_CAPTION_LIMIT + 1) },
        fetchImpl as unknown as typeof fetch,
      ),
    ).rejects.toMatchObject({ code: "caption_too_long" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("rejects non-https video urls without hitting the network", async () => {
    const fetchImpl = vi.fn();
    await expect(
      sendVideo("TOK", { chat_id: "@c", video: "http://insecure/v.mp4" }, fetchImpl as unknown as typeof fetch),
    ).rejects.toMatchObject({ code: "missing_video_url" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("maps 429 + retry_after to a retryable error", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(
        { ok: false, description: "Too Many Requests: retry after 31", error_code: 429, parameters: { retry_after: 31 } },
        429,
      ),
    );
    try {
      await sendVideo("TOK", { chat_id: "@c", video: "https://cdn.example/v.mp4" }, fetchImpl as unknown as typeof fetch);
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(TelegramApiError);
      const apiErr = err as TelegramApiError;
      expect(apiErr.code).toBe("telegram_rate_limited");
      expect(apiErr.retryable).toBe(true);
      expect(apiErr.retryAfterSeconds).toBe(31);
    }
  });

  it("maps 403 to a non-retryable forbidden error", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ ok: false, description: "Forbidden: bot is not a member", error_code: 403 }, 403),
    );
    try {
      await sendVideo("TOK", { chat_id: "@c", video: "https://cdn.example/v.mp4" }, fetchImpl as unknown as typeof fetch);
      expect.unreachable();
    } catch (err) {
      const apiErr = err as TelegramApiError;
      expect(apiErr.code).toBe("telegram_forbidden");
      expect(apiErr.retryable).toBe(false);
      expect(apiErr.status).toBe(403);
    }
  });

  it("maps network failures to retryable telegram_unreachable", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("boom");
    });
    await expect(
      sendVideo("TOK", { chat_id: "@c", video: "https://cdn.example/v.mp4" }, fetchImpl as unknown as typeof fetch),
    ).rejects.toMatchObject({ code: "telegram_unreachable", retryable: true });
  });

  it("refuses an empty bot token", async () => {
    const fetchImpl = vi.fn();
    await expect(
      sendVideo("", { chat_id: "@c", video: "https://cdn.example/v.mp4" }, fetchImpl as unknown as typeof fetch),
    ).rejects.toMatchObject({ code: "bot_token_missing" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("getChat", () => {
  it("returns the chat on ok:true", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ ok: true, result: { id: -100123, type: "channel", title: "My Chan" } }),
    );
    const chat = await getChat("TOK", "@mychan", fetchImpl as unknown as typeof fetch);
    expect(chat.title).toBe("My Chan");
  });
});
