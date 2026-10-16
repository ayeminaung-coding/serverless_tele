import { describe, expect, it } from "vitest";
import { app, type Env } from "../src/index";
import {
  CaptionValidationError,
  fit,
  normaliseHashtags,
  renderEpisode,
  substitute,
  tidy,
} from "../src/caption";
import { TELEGRAM_CAPTION_LIMIT } from "../src/telegram";

const COPY = {
  title_local: "အစွမ်းထက်ကူးပြောင်းသူ",
  title_en: "The Transmigrator",
  synopsis: "",
  language: "Burmese",
  style_example: "",
  caption_template: "အပိုင်း ({part}) {series}\n\n{hook}\n\n{next_teaser}\n{hashtags}",
  title_template: "အပိုင်း ({part}) {series}",
  next_teaser_template: "နောက်အပိုင်း ({next_part})",
  hashtags: "#MyanmarTiktok #fypviral",
};

function previewEnv(): Env {
  return {
    DB: {} as unknown as D1Database,
    MEDIA: {} as unknown as R2Bucket,
    R2_ACCOUNT_ID: "",
    R2_BUCKET: "",
    R2_ACCESS_KEY_ID: "",
    R2_SECRET_ACCESS_KEY: "",
    R2_PUBLIC_BASE_URL: "",
  };
}

describe("substitute", () => {
  it("replaces known fields", () => {
    expect(substitute("a{x}b", { x: "1" })).toBe("a1b");
  });

  it("leaves unknown fields visible so typos surface in preview", () => {
    expect(substitute("a{nope}b", { x: "1" })).toBe("a{nope}b");
  });

  it("substitutes empty values to nothing", () => {
    expect(substitute("a{x}b", { x: "" })).toBe("ab");
  });
});

describe("tidy", () => {
  it("collapses the hole an empty field leaves", () => {
    expect(tidy("one\n\n\n\ntwo")).toBe("one\n\ntwo");
  });

  it("strips leading and trailing blank lines", () => {
    expect(tidy("\n\nbody\n\n")).toBe("body");
  });

  it("drops trailing spaces", () => {
    expect(tidy("a   \nb")).toBe("a\nb");
  });
});

describe("fit", () => {
  it("leaves short text untouched", () => {
    expect(fit("abc", 10)).toBe("abc");
  });

  it("truncation fits inside the limit with an ellipsis", () => {
    const out = fit("x".repeat(100), 20);
    expect(out.length).toBeLessThanOrEqual(20);
    expect(out.endsWith("…")).toBe(true);
  });

  it("prefers a word boundary", () => {
    const out = fit("hello there wonderful world", 20);
    expect(out.startsWith("hello there")).toBe(true);
    expect(out).toContain("…");
  });

  it("does not gut scripts without spaces", () => {
    const text = "这是一段没有空格的中文文字".repeat(5);
    expect(fit(text, 20).length).toBeGreaterThanOrEqual(15);
  });
});

describe("renderEpisode", () => {
  it("renders a middle episode", () => {
    const out = renderEpisode(COPY, { part_index: 3, total: 8, hook: "သူမသိလိုက်တဲ့အခါ" });
    expect(out.caption).toContain("အပိုင်း (3)");
    expect(out.caption).toContain("အစွမ်းထက်ကူးပြောင်းသူ");
    expect(out.caption).toContain("သူမသိလိုက်တဲ့အခါ");
    expect(out.caption).toContain("နောက်အပိုင်း (4)");
    expect(out.caption).toContain("#MyanmarTiktok");
    expect(out.truncated).toBe(false);
  });

  it("final episode promises no next one and leaves no blank hole", () => {
    const out = renderEpisode(COPY, { part_index: 8, total: 8, hook: "နိဂုံး" });
    expect(out.caption).not.toContain("နောက်အပိုင်း");
    expect(out.caption).not.toContain("\n\n\n");
    expect(out.next_teaser).toBe("");
  });

  it("empty hook leaves no hole", () => {
    const out = renderEpisode(COPY, { part_index: 2, total: 8, hook: "" });
    expect(out.caption).not.toContain("\n\n\n");
    expect(out.caption.startsWith("အပိုင်း (2)")).toBe(true);
  });

  it("never exceeds the Telegram cap and flags truncation", () => {
    const out = renderEpisode({ caption_template: "{hook}", title_template: "{hook}" }, {
      part_index: 1,
      total: 1,
      hook: "x".repeat(9000),
    });
    expect(out.caption.length).toBeLessThanOrEqual(TELEGRAM_CAPTION_LIMIT);
    expect(out.truncated).toBe(true);
    expect(out.unfitted_length).toBe(9000);
  });

  it("defaults render without any configuration", () => {
    const out = renderEpisode({}, { part_index: 1, total: 2, hook: "" });
    expect(out.caption.length).toBeGreaterThan(0);
    expect(out.caption).toContain("အပိုင်း (1)");
  });

  it("rejects out-of-range parts and empty totals", () => {
    expect(() => renderEpisode(COPY, { part_index: 0, total: 8, hook: "h" })).toThrowError(
      CaptionValidationError,
    );
    expect(() => renderEpisode(COPY, { part_index: 9, total: 8, hook: "h" })).toThrowError(
      CaptionValidationError,
    );
    expect(() => renderEpisode(COPY, { part_index: 1, total: 0, hook: "h" })).toThrowError(
      CaptionValidationError,
    );
  });
});

describe("normaliseHashtags", () => {
  it("passes plain strings through", () => {
    expect(normaliseHashtags("#a #b")).toBe("#a #b");
  });

  it("reads the telegram key from a map", () => {
    expect(normaliseHashtags({ telegram: "#tg" })).toBe("#tg");
  });

  it("falls back to empty for anything else", () => {
    expect(normaliseHashtags(42)).toBe("");
    expect(normaliseHashtags(null)).toBe("");
  });
});

describe("POST /captions/preview", () => {
  it("renders without DB writes", async () => {
    const res = await app.request(
      "/captions/preview",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...COPY, part_index: 3, total_parts: 8, hook: "သူမသိလိုက်တဲ့အခါ" }),
      },
      previewEnv(),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      caption: string;
      title: string;
      caption_length: number;
      truncated: boolean;
      within_limit: boolean;
    };
    expect(body.caption).toContain("အပိုင်း (3)");
    expect(body.title).toContain("အပိုင်း (3)");
    expect(body.caption_length).toBe(body.caption.length);
    expect(body.truncated).toBe(false);
    expect(body.within_limit).toBe(true);
  });

  it("falls back to defaults when templates are omitted", async () => {
    const res = await app.request(
      "/captions/preview",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title_local: "My Show", part_index: 1, total_parts: 2, hook: "" }),
      },
      previewEnv(),
    );
    expect(res.status).toBe(200);
    expect(((await res.json()) as { caption: string }).caption).toContain("အပိုင်း (1)");
  });

  it("flags truncation instead of rejecting over-long renders", async () => {
    const res = await app.request(
      "/captions/preview",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          caption_template: "{hook}",
          part_index: 1,
          total_parts: 1,
          hook: "y".repeat(5000),
        }),
      },
      previewEnv(),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { caption: string; truncated: boolean; within_limit: boolean };
    expect(body.caption.length).toBeLessThanOrEqual(TELEGRAM_CAPTION_LIMIT);
    expect(body.truncated).toBe(true);
    expect(body.within_limit).toBe(true);
  });

  it("returns 400 for out-of-range parts", async () => {
    const res = await app.request(
      "/captions/preview",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ part_index: 9, total_parts: 8, hook: "h" }),
      },
      previewEnv(),
    );
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("invalid_part");
  });
});
