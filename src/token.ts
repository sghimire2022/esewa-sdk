/**
 * eSewa **Token payment**.
 *
 * Here the direction is reversed: your server issues a token (invoice no.,
 * customer ID, ...), the customer types it into the eSewa app, and **eSewa
 * calls your API** to look it up, pay it and check its status.
 *
 * `createTokenHandler()` gives you that API as a single Fetch-standard
 * handler `(Request) => Promise<Response>` that works in Next.js route
 * handlers, Hono, Bun, Deno, Cloudflare Workers, and Express/Fastify/Node via
 * {@link toNodeHandler}.
 */
import { type Amount, toPaisa } from "./amount.js";
import { base64ToUtf8, bytesToBase64, hmacSha256Base64, timingSafeEqual, utf8ToBase64 } from "./crypto.js";

/* -------------------------------------------------------------------------- */
/*                                    Types                                   */
/* -------------------------------------------------------------------------- */

/** A selectable package shown to the customer in the eSewa app. */
export interface TokenPackage {
  /** Label shown to the customer, e.g. "One Month Package". */
  display: string;
  /** Price of this package. */
  value: number;
  /** Echoed back to you (e.g. `package_id`) in the payment request. */
  properties?: Record<string, string | number>;
}

export type TokenFailure = { success: false; message: string };

export type InquiryResult =
  | {
      success: true;
      /** Amount the customer must pay. */
      amount: number;
      /** Details displayed to the customer (name, invoice no., ...). Values should be strings. */
      properties?: Record<string, string>;
      packages?: TokenPackage[];
      message?: string;
    }
  | TokenFailure;

export interface TokenPaymentRequest {
  requestId: string;
  amount: number;
  /** eSewa's transaction code. Use it as an idempotency key. */
  transactionCode: string;
  /** Set when the customer picked one of your packages. */
  packageId?: string | number;
  raw: Record<string, unknown>;
}

export type TokenPaymentResult =
  | {
      success: true;
      /** Your own reference, useful for reconciliation. */
      referenceCode: string;
      message?: string;
    }
  | TokenFailure;

export type TokenStatusRequest = Omit<TokenPaymentRequest, "packageId">;

export type TokenStatusResult =
  | {
      success: true;
      status: "SUCCESS" | "FAILED";
      referenceCode?: string;
      message?: string;
    }
  | TokenFailure;

export interface TokenRequestContext {
  request: Request;
}

/** HTTP Basic auth: eSewa sends the username/password you agreed on with every call. */
export interface BasicAuthConfig {
  type: "basic";
  username: string;
  password: string;
}

/**
 * Bearer auth: eSewa first calls `POST /access-token` with
 * `{ grant_type: "password", client_secret, username, password }`, receives a
 * short-lived token and sends it as `Authorization: Bearer <token>`.
 * The SDK issues and verifies stateless HMAC-signed tokens for you.
 */
export interface BearerAuthConfig {
  type: "bearer";
  /** Client secret shared with eSewa (eSewa sends it base64 encoded). */
  clientSecret: string;
  username: string;
  password: string;
  /** Secret used to sign issued tokens. At least 32 characters. Never share it. */
  signingKey: string;
  /** Access token lifetime in seconds. Default 300. */
  accessTokenTtl?: number;
  /** Refresh token lifetime in seconds. Default 600. */
  refreshTokenTtl?: number;
}

export interface TokenHandlerOptions {
  auth: BasicAuthConfig | BearerAuthConfig;
  /** Look up the token/request ID the customer entered. */
  inquiry(requestId: string, ctx: TokenRequestContext): Promise<InquiryResult> | InquiryResult;
  /**
   * Mark the token as paid. **Must be idempotent** on `transactionCode`:
   * eSewa may retry, and a retry must not create a second payment.
   */
  payment(req: TokenPaymentRequest, ctx: TokenRequestContext): Promise<TokenPaymentResult> | TokenPaymentResult;
  /** Report whether a payment was recorded on your side. */
  status(req: TokenStatusRequest, ctx: TokenRequestContext): Promise<TokenStatusResult> | TokenStatusResult;
  /** Path prefix the handler is mounted under, e.g. "/api/esewa". Default "". */
  basePath?: string;
  /** Override the route paths. Defaults match eSewa's documentation. */
  routes?: Partial<{ accessToken: string; inquiry: string; payment: string; status: string }>;
  /** Called with unexpected errors thrown by your callbacks. */
  onError?(error: unknown, ctx: TokenRequestContext): void;
  /** Clock override, for tests. Returns ms since epoch. */
  now?(): number;
}

/* -------------------------------------------------------------------------- */
/*                                   Helpers                                  */
/* -------------------------------------------------------------------------- */

const JSON_HEADERS = { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" };

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...JSON_HEADERS, ...headers } });
}

function normalizePath(p: string): string {
  const s = ("/" + p).replace(/\/+/g, "/");
  return s.length > 1 ? s.replace(/\/$/, "") : s;
}

/** Compares a received secret against the expected one, accepting plain or base64-encoded input. */
function secretMatches(received: unknown, expected: string): boolean {
  if (typeof received !== "string" || !received) return false;
  if (timingSafeEqual(received, expected)) return true;
  try {
    return timingSafeEqual(base64ToUtf8(received), expected);
  } catch {
    return false;
  }
}

function toAmount(v: unknown): number {
  return toPaisa(v as Amount) / 100;
}

function b64url(s: string): string {
  return s.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

interface TokenClaims {
  typ: "access" | "refresh";
  sub: string;
  exp: number;
  jti: string;
}

async function signToken(key: string, claims: TokenClaims): Promise<string> {
  const payload = b64url(utf8ToBase64(JSON.stringify(claims)));
  const sig = b64url(await hmacSha256Base64(key, payload));
  return `${payload}.${sig}`;
}

async function verifyToken(key: string, token: string, typ: TokenClaims["typ"], nowSec: number): Promise<boolean> {
  const [payload, sig, extra] = token.split(".");
  if (!payload || !sig || extra !== undefined) return false;
  const expected = b64url(await hmacSha256Base64(key, payload));
  if (!timingSafeEqual(expected, sig)) return false;
  try {
    const claims = JSON.parse(base64ToUtf8(payload)) as TokenClaims;
    return claims.typ === typ && typeof claims.exp === "number" && claims.exp > nowSec;
  } catch {
    return false;
  }
}

function randomId(): string {
  const b = new Uint8Array(12);
  globalThis.crypto.getRandomValues(b);
  return b64url(bytesToBase64(b));
}

/* -------------------------------------------------------------------------- */
/*                                   Handler                                  */
/* -------------------------------------------------------------------------- */

/**
 * Creates the API eSewa calls for Token payments.
 *
 * Routes (relative to `basePath`):
 * - `POST /access-token`   (bearer auth only)
 * - `GET  /inquiry/:requestId`
 * - `POST /payment`
 * - `POST /status`
 */
export function createTokenHandler(options: TokenHandlerOptions): (request: Request) => Promise<Response> {
  const { auth } = options;
  if (!auth) throw new Error("esewa-sdk: `auth` is required");
  if (auth.type === "bearer" && (!auth.signingKey || auth.signingKey.length < 32)) {
    throw new Error("esewa-sdk: bearer `signingKey` must be at least 32 characters");
  }
  const now = options.now ?? Date.now;
  const base = options.basePath ? normalizePath(options.basePath) : "";
  const r = {
    accessToken: normalizePath(options.routes?.accessToken ?? "/access-token"),
    inquiry: normalizePath(options.routes?.inquiry ?? "/inquiry"),
    payment: normalizePath(options.routes?.payment ?? "/payment"),
    status: normalizePath(options.routes?.status ?? "/status"),
  };
  const accessTtl = auth.type === "bearer" ? (auth.accessTokenTtl ?? 300) : 0;
  const refreshTtl = auth.type === "bearer" ? (auth.refreshTokenTtl ?? 600) : 0;

  async function isAuthorized(req: Request): Promise<boolean> {
    const header = req.headers.get("authorization") ?? "";
    const space = header.indexOf(" ");
    const scheme = header.slice(0, space).toLowerCase();
    const value = header.slice(space + 1).trim();
    if (auth.type === "basic") {
      if (scheme !== "basic" || !value) return false;
      let decoded: string;
      try {
        decoded = base64ToUtf8(value);
      } catch {
        return false;
      }
      const i = decoded.indexOf(":");
      if (i < 0) return false;
      // Evaluate both to keep timing independent of which part is wrong.
      const u = timingSafeEqual(decoded.slice(0, i), auth.username);
      const p = timingSafeEqual(decoded.slice(i + 1), auth.password);
      return u && p;
    }
    if (scheme !== "bearer" || !value) return false;
    return verifyToken(auth.signingKey, value, "access", Math.floor(now() / 1000));
  }

  async function readBody(req: Request): Promise<Record<string, unknown> | null> {
    try {
      const text = await req.text();
      if (!text) return {};
      const ct = req.headers.get("content-type") ?? "";
      if (ct.includes("application/x-www-form-urlencoded")) return Object.fromEntries(new URLSearchParams(text));
      const v: unknown = JSON.parse(text);
      return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
    } catch {
      return null;
    }
  }

  async function issueTokens(subject: string): Promise<Response> {
    const a = auth as BearerAuthConfig;
    const nowSec = Math.floor(now() / 1000);
    const access_token = await signToken(a.signingKey, { typ: "access", sub: subject, exp: nowSec + accessTtl, jti: randomId() });
    const refresh_token = await signToken(a.signingKey, {
      typ: "refresh",
      sub: subject,
      exp: nowSec + refreshTtl,
      jti: randomId(),
    });
    return json({
      access_token,
      expires_in: accessTtl,
      token_type: "Bearer",
      refresh_token,
      refresh_expires_in: refreshTtl,
    });
  }

  async function handleAccessToken(req: Request): Promise<Response> {
    if (auth.type !== "bearer") return json({ error: "not_found" }, 404);
    const body = await readBody(req);
    if (!body) return json({ error: "invalid_request", error_description: "Body must be JSON" }, 400);
    if (!secretMatches(body.client_secret, auth.clientSecret)) {
      return json({ error: "invalid_client" }, 401);
    }
    if (body.grant_type === "password") {
      const userOk = typeof body.username === "string" && timingSafeEqual(body.username, auth.username);
      const passOk = secretMatches(body.password, auth.password);
      if (!userOk || !passOk) return json({ error: "invalid_grant" }, 401);
      return issueTokens(auth.username);
    }
    if (body.grant_type === "refresh_token") {
      const ok =
        typeof body.refresh_token === "string" &&
        (await verifyToken(auth.signingKey, body.refresh_token, "refresh", Math.floor(now() / 1000)));
      if (!ok) return json({ error: "invalid_grant" }, 401);
      return issueTokens(auth.username);
    }
    return json({ error: "unsupported_grant_type" }, 400);
  }

  function failure(requestId: string, message: string, extra: Record<string, unknown> = {}): Response {
    return json({ request_id: requestId, response_code: 1, response_message: message, ...extra });
  }

  function parsePaymentLike(body: Record<string, unknown>): TokenPaymentRequest | string {
    const requestId = body.request_id;
    const transactionCode = body.transaction_code;
    if (typeof requestId !== "string" && typeof requestId !== "number") return "request_id is required";
    if (typeof transactionCode !== "string" || !transactionCode) return "transaction_code is required";
    let amount: number;
    try {
      amount = toAmount(body.amount);
    } catch {
      return "amount is invalid";
    }
    const pkg = body.package_id;
    return {
      requestId: String(requestId),
      amount,
      transactionCode,
      ...(typeof pkg === "string" || typeof pkg === "number" ? { packageId: pkg } : {}),
      raw: body,
    };
  }

  return async function handler(request: Request): Promise<Response> {
    const ctx: TokenRequestContext = { request };
    let path: string;
    try {
      path = normalizePath(new URL(request.url).pathname);
    } catch {
      return json({ error: "bad_request" }, 400);
    }
    if (base) {
      if (path !== base && !path.startsWith(base + "/")) return json({ error: "not_found" }, 404);
      path = normalizePath(path.slice(base.length) || "/");
    }
    const method = request.method.toUpperCase();

    try {
      if (path === r.accessToken) {
        if (method !== "POST") return json({ error: "method_not_allowed" }, 405, { allow: "POST" });
        return await handleAccessToken(request);
      }

      const isInquiry = path.startsWith(r.inquiry + "/");
      const isPayment = path === r.payment;
      const isStatus = path === r.status;
      if (!isInquiry && !isPayment && !isStatus) return json({ error: "not_found" }, 404);

      if (!(await isAuthorized(request))) {
        return json({ response_code: 1, response_message: "Unauthorized" }, 401, {
          "www-authenticate": auth.type === "basic" ? 'Basic realm="esewa"' : "Bearer",
        });
      }

      if (isInquiry) {
        if (method !== "GET") return json({ error: "method_not_allowed" }, 405, { allow: "GET" });
        const requestId = decodeURIComponent(path.slice(r.inquiry.length + 1));
        if (!requestId || requestId.includes("/")) return failure(requestId, "Invalid request id");
        const result = await options.inquiry(requestId, ctx);
        if (!result.success) return failure(requestId, result.message);
        return json({
          request_id: requestId,
          response_code: 0,
          response_message: result.message ?? "success",
          amount: result.amount,
          properties: result.properties ?? {},
          ...(result.packages ? { packages: result.packages } : {}),
        });
      }

      if (method !== "POST") return json({ error: "method_not_allowed" }, 405, { allow: "POST" });
      const body = await readBody(request);
      if (!body) return failure("", "Body must be JSON");
      const parsed = parsePaymentLike(body);
      if (typeof parsed === "string") return failure(String(body.request_id ?? ""), parsed);

      if (isPayment) {
        const result = await options.payment(parsed, ctx);
        if (!result.success) return failure(parsed.requestId, result.message, { amount: parsed.amount });
        return json({
          request_id: parsed.requestId,
          response_code: 0,
          response_message: result.message ?? "Payment successful",
          amount: parsed.amount,
          reference_code: result.referenceCode,
        });
      }

      const { packageId: _ignored, ...statusReq } = parsed;
      const result = await options.status(statusReq, ctx);
      if (!result.success) {
        return failure(parsed.requestId, result.message, {
          status: "FAILED",
          amount: parsed.amount,
          reference_code: "",
        });
      }
      return json({
        request_id: parsed.requestId,
        response_code: result.status === "SUCCESS" ? 0 : 1,
        status: result.status,
        response_message: result.message ?? (result.status === "SUCCESS" ? "Payment successful" : "Payment Not Found"),
        amount: parsed.amount,
        reference_code: result.referenceCode ?? "",
      });
    } catch (error) {
      options.onError?.(error, ctx);
      return json({ response_code: 1, response_message: "Internal server error" }, 500);
    }
  };
}

/* -------------------------------------------------------------------------- */
/*                                Node adapter                                */
/* -------------------------------------------------------------------------- */

/** Minimal structural types so the SDK has no dependency on `@types/node` or Express. */
interface NodeLikeRequest extends AsyncIterable<unknown> {
  method?: string;
  url?: string;
  originalUrl?: string;
  headers: Record<string, string | string[] | undefined>;
  /** Pre-parsed body (Express `express.json()` etc.). */
  body?: unknown;
}
interface NodeLikeResponse {
  statusCode: number;
  setHeader(name: string, value: string): unknown;
  end(chunk?: string): unknown;
}

/**
 * Wraps a Fetch-style handler for Node's `http`, Express, Connect or Fastify (raw).
 *
 * @example
 * app.use("/api/esewa", toNodeHandler(createTokenHandler({ basePath: "/api/esewa", ... })));
 */
export function toNodeHandler(handler: (request: Request) => Promise<Response>) {
  return async (req: NodeLikeRequest, res: NodeLikeResponse): Promise<void> => {
    const headers = new Headers();
    for (const [k, v] of Object.entries(req.headers)) {
      if (v === undefined) continue;
      for (const item of Array.isArray(v) ? v : [v]) headers.append(k, item);
    }
    const host = headers.get("host") ?? "localhost";
    const url = new URL(req.originalUrl ?? req.url ?? "/", `http://${host}`);
    const method = (req.method ?? "GET").toUpperCase();

    let body: string | undefined;
    if (method !== "GET" && method !== "HEAD") {
      if (req.body !== undefined && req.body !== null) {
        if (typeof req.body === "string") body = req.body;
        else if (req.body instanceof Uint8Array) body = new TextDecoder().decode(req.body);
        else {
          body = JSON.stringify(req.body);
          headers.set("content-type", "application/json");
        }
      } else {
        const chunks: Uint8Array[] = [];
        for await (const chunk of req) {
          chunks.push(typeof chunk === "string" ? new TextEncoder().encode(chunk) : (chunk as Uint8Array));
        }
        const total = chunks.reduce((n, c) => n + c.length, 0);
        const merged = new Uint8Array(total);
        let off = 0;
        for (const c of chunks) {
          merged.set(c, off);
          off += c.length;
        }
        body = new TextDecoder().decode(merged);
      }
    }

    const response = await handler(new Request(url, { method, headers, body }));
    res.statusCode = response.status;
    response.headers.forEach((value, key) => res.setHeader(key, value));
    res.end(await response.text());
  };
}
