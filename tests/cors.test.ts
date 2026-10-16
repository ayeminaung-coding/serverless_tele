import { describe, expect, it } from "vitest";
import { app, type Env } from "../src/index";

function env(): Env {
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

describe("CORS (Pages console calls cross-origin)", () => {
  it("answers preflight with an allow-origin", async () => {
    const res = await app.request(
      "/channels",
      {
        method: "OPTIONS",
        headers: {
          Origin: "https://telegram-console.pages.dev",
          "Access-Control-Request-Method": "POST",
        },
      },
      env(),
    );
    expect(res.headers.get("access-control-allow-origin")).toBeTruthy();
  });

  it("stamps real responses so the console can read them", async () => {
    const res = await app.request(
      "/healthz",
      { headers: { Origin: "http://localhost:8000" } },
      env(),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("access-control-allow-origin")).toBeTruthy();
  });
});
