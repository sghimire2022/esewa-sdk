import { describe, expect, it, vi } from "vitest";
import { createTokenHandler, toNodeHandler, type TokenHandlerOptions } from "../src/index.js";

const BASE = "https://merchant.example/api/esewa";
const basicHeader = "Basic " + Buffer.from("esewa:s3cret").toString("base64");

function callbacks(): Pick<TokenHandlerOptions, "inquiry" | "payment" | "status"> {
  const paid = new Map<string, string>();
  return {
    inquiry: vi.fn(async (id: string) =>
      id === "12123122"
        ? { success: true as const, amount: 1000, properties: { customer_name: "Ram Kumar Thapa" } }
        : { success: false as const, message: "Invalid token" },
    ),
    payment: vi.fn(async (req) => {
      if (req.requestId !== "12123122") return { success: false as const, message: "Invalid token" };
      const ref = paid.get(req.transactionCode) ?? `REF-${paid.size + 1}`;
      paid.set(req.transactionCode, ref);
      return { success: true as const, referenceCode: ref };
    }),
    status: vi.fn(async (req) => {
      const ref = paid.get(req.transactionCode);
      return ref
        ? { success: true as const, status: "SUCCESS" as const, referenceCode: ref }
        : { success: true as const, status: "FAILED" as const, message: "Payment Not Found" };
    }),
  };
}

const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
  new Request(BASE + path, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });

describe("token handler (basic auth)", () => {
  const handler = createTokenHandler({
    auth: { type: "basic", username: "esewa", password: "s3cret" },
    basePath: "/api/esewa",
    ...callbacks(),
  });

  it("requires auth", async () => {
    const res = await handler(new Request(BASE + "/inquiry/12123122"));
    expect(res.status).toBe(401);
    const bad = await handler(
      new Request(BASE + "/inquiry/12123122", { headers: { authorization: "Basic " + btoa("esewa:nope") } }),
    );
    expect(bad.status).toBe(401);
  });

  it("answers inquiry in eSewa's format", async () => {
    const res = await handler(new Request(BASE + "/inquiry/12123122", { headers: { authorization: basicHeader } }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      request_id: "12123122",
      response_code: 0,
      response_message: "success",
      amount: 1000,
      properties: { customer_name: "Ram Kumar Thapa" },
    });
    const unknown = await handler(new Request(BASE + "/inquiry/999", { headers: { authorization: basicHeader } }));
    expect(await unknown.json()).toEqual({ request_id: "999", response_code: 1, response_message: "Invalid token" });
  });

  it("handles payment then status, idempotently", async () => {
    const body = { request_id: "12123122", amount: 1000, transaction_code: "01XV31A" };
    const p1 = await (await handler(post("/payment", body, { authorization: basicHeader }))).json();
    const p2 = await (await handler(post("/payment", body, { authorization: basicHeader }))).json();
    expect(p1).toEqual({
      request_id: "12123122",
      response_code: 0,
      response_message: "Payment successful",
      amount: 1000,
      reference_code: "REF-1",
    });
    expect(p2.reference_code).toBe("REF-1");

    const s = await (await handler(post("/status", body, { authorization: basicHeader }))).json();
    expect(s).toMatchObject({ response_code: 0, status: "SUCCESS", reference_code: "REF-1" });
    const missing = await (
      await handler(post("/status", { ...body, transaction_code: "NOPE" }, { authorization: basicHeader }))
    ).json();
    expect(missing).toMatchObject({ response_code: 1, status: "FAILED", response_message: "Payment Not Found" });
  });

  it("validates payment bodies", async () => {
    const res = await (await handler(post("/payment", { request_id: "1" }, { authorization: basicHeader }))).json();
    expect(res).toMatchObject({ response_code: 1, response_message: "transaction_code is required" });
    const amt = await (
      await handler(post("/payment", { request_id: "1", transaction_code: "x", amount: "abc" }, { authorization: basicHeader }))
    ).json();
    expect(amt.response_message).toBe("amount is invalid");
  });

  it("returns 404/405 and hides callback errors", async () => {
    expect((await handler(new Request(BASE + "/nope"))).status).toBe(404);
    expect((await handler(new Request(BASE + "/payment", { headers: { authorization: basicHeader } }))).status).toBe(405);
    const onError = vi.fn();
    const boom = createTokenHandler({
      auth: { type: "basic", username: "esewa", password: "s3cret" },
      inquiry: () => {
        throw new Error("db down");
      },
      payment: () => ({ success: false, message: "" }),
      status: () => ({ success: false, message: "" }),
      onError,
    });
    const res = await boom(new Request("https://x/inquiry/1", { headers: { authorization: basicHeader } }));
    expect(res.status).toBe(500);
    expect(JSON.stringify(await res.json())).not.toContain("db down");
    expect(onError).toHaveBeenCalled();
  });
});

describe("token handler (bearer auth)", () => {
  let clock = 1_700_000_000_000;
  const handler = createTokenHandler({
    auth: {
      type: "bearer",
      clientSecret: "client-secret-0123456789abcdef0123",
      username: "esewa",
      password: "p@ss",
      signingKey: "signing-key-0123456789abcdef0123456789",
      accessTokenTtl: 250,
      refreshTokenTtl: 550,
    },
    now: () => clock,
    ...callbacks(),
  });
  const login = {
    grant_type: "password",
    client_secret: btoa("client-secret-0123456789abcdef0123"),
    username: "esewa",
    password: btoa("p@ss"),
  };

  it("issues, uses, expires and refreshes tokens", async () => {
    const res = await handler(new Request("https://m/access-token", { method: "POST", body: JSON.stringify(login) }));
    expect(res.status).toBe(200);
    const tok = await res.json();
    expect(tok).toMatchObject({ token_type: "Bearer", expires_in: 250, refresh_expires_in: 550 });

    const auth = { authorization: `${tok.token_type} ${tok.access_token}` };
    expect((await handler(new Request("https://m/inquiry/12123122", { headers: auth }))).status).toBe(200);

    // Refresh tokens can't be used as access tokens.
    const asAccess = { authorization: `Bearer ${tok.refresh_token}` };
    expect((await handler(new Request("https://m/inquiry/12123122", { headers: asAccess }))).status).toBe(401);

    clock += 251_000;
    expect((await handler(new Request("https://m/inquiry/12123122", { headers: auth }))).status).toBe(401);

    const refreshed = await handler(
      new Request("https://m/access-token", {
        method: "POST",
        body: JSON.stringify({ grant_type: "refresh_token", refresh_token: tok.refresh_token, client_secret: login.client_secret }),
      }),
    );
    expect(refreshed.status).toBe(200);
    const tok2 = await refreshed.json();
    expect(
      (await handler(new Request("https://m/inquiry/12123122", { headers: { authorization: `Bearer ${tok2.access_token}` } })))
        .status,
    ).toBe(200);
  });

  it("rejects bad credentials and forged tokens", async () => {
    const bad = await handler(
      new Request("https://m/access-token", { method: "POST", body: JSON.stringify({ ...login, password: btoa("x") }) }),
    );
    expect(bad.status).toBe(401);
    const badClient = await handler(
      new Request("https://m/access-token", { method: "POST", body: JSON.stringify({ ...login, client_secret: "x" }) }),
    );
    expect(badClient.status).toBe(401);
    const forged = btoa(JSON.stringify({ typ: "access", sub: "esewa", exp: 9e12 })) + ".AAAA";
    expect((await handler(new Request("https://m/inquiry/1", { headers: { authorization: `Bearer ${forged}` } }))).status).toBe(401);
  });

  it("requires a strong signing key", () => {
    expect(() =>
      createTokenHandler({
        auth: { type: "bearer", clientSecret: "a", username: "b", password: "c", signingKey: "short" },
        ...callbacks(),
      }),
    ).toThrow();
  });
});

describe("toNodeHandler", () => {
  it("bridges Express-style req/res (pre-parsed body, originalUrl)", async () => {
    const node = toNodeHandler(
      createTokenHandler({
        auth: { type: "basic", username: "esewa", password: "s3cret" },
        basePath: "/api/esewa",
        ...callbacks(),
      }),
    );
    const req = Object.assign((async function* () {})(), {
      method: "POST",
      url: "/payment",
      originalUrl: "/api/esewa/payment",
      headers: { host: "merchant.example", authorization: basicHeader, "content-type": "application/json" },
      body: { request_id: "12123122", amount: "1000", transaction_code: "AB1" },
    });
    const headers: Record<string, string> = {};
    let ended = "";
    const res = {
      statusCode: 0,
      setHeader: (k: string, v: string) => (headers[k] = v),
      end: (c?: string) => (ended = c ?? ""),
    };
    await node(req, res);
    expect(res.statusCode).toBe(200);
    expect(headers["content-type"]).toContain("application/json");
    expect(JSON.parse(ended)).toMatchObject({ response_code: 0, amount: 1000, reference_code: "REF-1" });
  });

  it("reads a raw streamed body", async () => {
    const node = toNodeHandler(
      createTokenHandler({ auth: { type: "basic", username: "esewa", password: "s3cret" }, ...callbacks() }),
    );
    const payload = JSON.stringify({ request_id: "12123122", amount: 1000, transaction_code: "Z" });
    const req = Object.assign(
      (async function* () {
        yield Buffer.from(payload.slice(0, 10));
        yield Buffer.from(payload.slice(10));
      })(),
      { method: "POST", url: "/payment", headers: { host: "m", authorization: basicHeader } },
    );
    let ended = "";
    const res = { statusCode: 0, setHeader: () => undefined, end: (c?: string) => (ended = c ?? "") };
    await node(req, res);
    expect(JSON.parse(ended).response_code).toBe(0);
  });
});
