import { type Amount, amountsEqual, formatAmount, formatPaisa, toPaisa } from "./amount.js";
import { EPAY_URLS, type EpayUrls, type EsewaEnvironment, REQUEST_SIGNED_FIELDS } from "./constants.js";
import { base64ToUtf8, hmacSha256Base64, timingSafeEqual } from "./crypto.js";
import { EsewaError } from "./errors.js";

/* -------------------------------------------------------------------------- */
/*                                    Types                                   */
/* -------------------------------------------------------------------------- */

export interface EsewaEpayConfig {
  /** Merchant/product code issued by eSewa (`EPAYTEST` in UAT). */
  productCode: string;
  /** HMAC secret key issued by eSewa. Keep this on the server. */
  secretKey: string;
  /** Defaults to `"test"`. */
  environment?: EsewaEnvironment;
  /** Default redirect after a successful payment (can be overridden per payment). */
  successUrl?: string;
  /** Default redirect after a failed / cancelled / pending payment. */
  failureUrl?: string;
  /** Override endpoint URLs (e.g. for a proxy or a mock server). */
  urls?: Partial<EpayUrls>;
  /** Custom `fetch` implementation. Defaults to `globalThis.fetch`. */
  fetch?: typeof fetch;
  /** Timeout for status-check requests, in ms. Defaults to 15000. */
  timeoutMs?: number;
}

export interface CreatePaymentInput {
  /** Price of the product (excluding tax and charges). */
  amount: Amount;
  /** Defaults to 0. */
  taxAmount?: Amount;
  /** Merchant service charge. Defaults to 0. */
  serviceCharge?: Amount;
  /** Delivery charge. Defaults to 0. */
  deliveryCharge?: Amount;
  /**
   * Your unique ID for this payment attempt (alphanumeric and `-` only).
   * Must be unique on every request. A random UUID is generated if omitted.
   */
  transactionUuid?: string;
  successUrl?: string;
  failureUrl?: string;
}

/** The exact form fields eSewa's ePay v2 endpoint expects. */
export interface EpayFormFields {
  amount: string;
  tax_amount: string;
  total_amount: string;
  transaction_uuid: string;
  product_code: string;
  product_service_charge: string;
  product_delivery_charge: string;
  success_url: string;
  failure_url: string;
  signed_field_names: string;
  signature: string;
}

export interface EpayPaymentRequest {
  /** URL to POST `fields` to (as an HTML form submitted by the customer's browser). */
  url: string;
  method: "POST";
  fields: EpayFormFields;
  /** Convenience copies, useful for persisting the pending order. */
  transactionUuid: string;
  totalAmount: string;
}

export type EpayStatus =
  | "COMPLETE"
  | "PENDING"
  | "FULL_REFUND"
  | "PARTIAL_REFUND"
  | "AMBIGUOUS"
  | "NOT_FOUND"
  | "CANCELED";

/** Decoded, signature-verified payload eSewa sends to your success URL. */
export interface EpayCallback {
  transactionCode: string;
  status: EpayStatus | (string & {});
  /** Amount exactly as eSewa sent it (may look like "1,000.0"). */
  totalAmount: string;
  /** Same amount normalised to eSewa's canonical form, e.g. "1000". */
  totalAmountNormalized: string;
  transactionUuid: string;
  productCode: string;
  /** The full decoded JSON object. */
  raw: Record<string, unknown>;
}

export interface EpayStatusResult {
  productCode: string;
  transactionUuid: string;
  totalAmount: number;
  status: EpayStatus | (string & {});
  /** eSewa reference / transaction code. `null` while PENDING or when NOT_FOUND. */
  refId: string | null;
  raw: Record<string, unknown>;
}

export interface ConfirmPaymentOptions {
  /** Amount you expected to be charged. Strongly recommended: guards against tampered orders. */
  expectedAmount?: Amount;
  /** Your transaction UUID for this order. Guards against replaying another order's callback. */
  expectedTransactionUuid?: string;
  /**
   * Also call eSewa's status API to confirm the payment server-to-server.
   * Defaults to `true`. Only disable if you have your own reconciliation.
   */
  verifyWithStatusApi?: boolean;
}

export interface ConfirmedPayment {
  callback: EpayCallback;
  /** Present when `verifyWithStatusApi` is enabled (the default). */
  status?: EpayStatusResult;
}

/** Anything the success redirect might hand you. */
export type CallbackInput = string | URL | URLSearchParams | Record<string, unknown>;

/* -------------------------------------------------------------------------- */
/*                                   Helpers                                  */
/* -------------------------------------------------------------------------- */

const UUID_RE = /^[A-Za-z0-9-]+$/;

/**
 * Builds the HMAC message `k1=v1,k2=v2,...` for the given field order and
 * returns its base64 HMAC-SHA256 signature.
 */
export async function generateSignature(
  secretKey: string,
  values: Record<string, string>,
  signedFieldNames: readonly string[] = REQUEST_SIGNED_FIELDS,
): Promise<string> {
  const message = signedFieldNames
    .map((name) => {
      const v = values[name];
      if (v === undefined) {
        throw new EsewaError("INVALID_PARAMS", `Signed field "${name}" is missing`);
      }
      return `${name}=${v}`;
    })
    .join(",");
  return hmacSha256Base64(secretKey, message);
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

/**
 * Renders a self-submitting HTML form that sends the customer to eSewa.
 * Return it from a server route as `text/html`.
 */
export function renderPaymentForm(
  request: Pick<EpayPaymentRequest, "url" | "fields">,
  options: { autoSubmit?: boolean; buttonText?: string; nonce?: string } = {},
): string {
  const { autoSubmit = true, buttonText = "Pay with eSewa", nonce } = options;
  const inputs = Object.entries(request.fields)
    .map(([k, v]) => `<input type="hidden" name="${escapeHtml(k)}" value="${escapeHtml(String(v))}">`)
    .join("");
  const nonceAttr = nonce ? ` nonce="${escapeHtml(nonce)}"` : "";
  const script = autoSubmit
    ? `<script${nonceAttr}>document.getElementById("esewa-pay").submit();</script>`
    : "";
  return (
    `<!doctype html><html><head><meta charset="utf-8"><title>Redirecting to eSewa…</title></head><body>` +
    `<form id="esewa-pay" action="${escapeHtml(request.url)}" method="POST">${inputs}` +
    `<noscript><p>Click the button to continue to eSewa.</p></noscript>` +
    `<button type="submit">${escapeHtml(buttonText)}</button></form>${script}</body></html>`
  );
}

/** Extracts the base64 `data` value from a URL, query string, params object or raw string. */
function extractCallbackData(input: CallbackInput): string {
  if (input instanceof URL) return extractCallbackData(input.searchParams);
  if (input instanceof URLSearchParams) {
    const d = input.get("data");
    if (!d) throw new EsewaError("INVALID_RESPONSE", "Callback has no `data` parameter");
    return d;
  }
  if (typeof input === "object" && input !== null) {
    const d = (input as Record<string, unknown>).data;
    if (typeof d !== "string" || !d) throw new EsewaError("INVALID_RESPONSE", "Callback has no `data` parameter");
    return d;
  }
  const s = String(input).trim();
  if (/^https?:\/\//i.test(s)) return extractCallbackData(new URL(s));
  if (s.startsWith("?") || /(^|&)data=/.test(s)) return extractCallbackData(new URLSearchParams(s));
  return s;
}

/**
 * Returns the textual value of a top-level JSON field exactly as written in
 * the source, so numbers like `1000.0` keep their formatting when re-signed.
 */
function rawJsonValue(json: string, field: string, parsed: unknown): string | undefined {
  if (typeof parsed === "string") return parsed;
  if (parsed === undefined) return undefined;
  const esc = field.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const m = new RegExp(`"${esc}"\\s*:\\s*(-?[0-9][0-9.eE+-]*|true|false|null)`).exec(json);
  return m?.[1] ?? String(parsed);
}

/* -------------------------------------------------------------------------- */
/*                                   Client                                   */
/* -------------------------------------------------------------------------- */

/**
 * eSewa ePay v2 client. Use it on your **server** — it needs your secret key.
 *
 * @example
 * const esewa = new EsewaEpay({ productCode: "EPAYTEST", secretKey: "8gBm/:&EnhH.1/q" });
 * const payment = await esewa.createPayment({ amount: 100, successUrl, failureUrl });
 * // send renderPaymentForm(payment) to the browser, or post payment.fields from your frontend
 */
export class EsewaEpay {
  readonly environment: EsewaEnvironment;
  readonly productCode: string;
  readonly urls: EpayUrls;
  readonly #secretKey: string;
  readonly #fetch: typeof fetch;
  readonly #timeoutMs: number;
  readonly #successUrl?: string;
  readonly #failureUrl?: string;

  constructor(config: EsewaEpayConfig) {
    if (!config || typeof config !== "object") throw new EsewaError("INVALID_CONFIG", "Config object is required");
    if (!config.productCode) throw new EsewaError("INVALID_CONFIG", "`productCode` is required");
    if (!config.secretKey) throw new EsewaError("INVALID_CONFIG", "`secretKey` is required");
    const env = config.environment ?? "test";
    if (env !== "test" && env !== "production") {
      throw new EsewaError("INVALID_CONFIG", '`environment` must be "test" or "production"');
    }
    const f = config.fetch ?? globalThis.fetch;
    if (typeof f !== "function") {
      throw new EsewaError("INVALID_CONFIG", "No `fetch` available; pass one in config.fetch");
    }
    this.environment = env;
    this.productCode = config.productCode;
    this.urls = { ...EPAY_URLS[env], ...config.urls };
    this.#secretKey = config.secretKey;
    this.#fetch = f.bind(globalThis);
    this.#timeoutMs = config.timeoutMs ?? 15_000;
    this.#successUrl = config.successUrl;
    this.#failureUrl = config.failureUrl;
  }

  /** Builds and signs a payment request. Nothing is sent to eSewa yet. */
  async createPayment(input: CreatePaymentInput): Promise<EpayPaymentRequest> {
    if (!input || typeof input !== "object") throw new EsewaError("INVALID_PARAMS", "Payment input is required");

    const amount = toPaisa(input.amount, "amount");
    if (amount <= 0) throw new EsewaError("INVALID_PARAMS", "amount must be greater than 0");
    const tax = toPaisa(input.taxAmount ?? 0, "taxAmount");
    const service = toPaisa(input.serviceCharge ?? 0, "serviceCharge");
    const delivery = toPaisa(input.deliveryCharge ?? 0, "deliveryCharge");
    const total = amount + tax + service + delivery;

    const transactionUuid = input.transactionUuid ?? globalThis.crypto.randomUUID();
    if (!UUID_RE.test(transactionUuid)) {
      throw new EsewaError("INVALID_PARAMS", "transactionUuid may only contain letters, digits and hyphens", {
        transactionUuid,
      });
    }

    const successUrl = input.successUrl ?? this.#successUrl;
    const failureUrl = input.failureUrl ?? this.#failureUrl;
    if (!successUrl || !failureUrl) {
      throw new EsewaError("INVALID_PARAMS", "successUrl and failureUrl are required (per payment or in config)");
    }
    for (const [name, u] of [
      ["successUrl", successUrl],
      ["failureUrl", failureUrl],
    ] as const) {
      try {
        new URL(u);
      } catch {
        throw new EsewaError("INVALID_PARAMS", `${name} must be an absolute URL`, { [name]: u });
      }
    }

    const unsigned = {
      amount: formatPaisa(amount),
      tax_amount: formatPaisa(tax),
      total_amount: formatPaisa(total),
      transaction_uuid: transactionUuid,
      product_code: this.productCode,
      product_service_charge: formatPaisa(service),
      product_delivery_charge: formatPaisa(delivery),
      success_url: successUrl,
      failure_url: failureUrl,
      signed_field_names: REQUEST_SIGNED_FIELDS.join(","),
    };
    const signature = await generateSignature(this.#secretKey, unsigned, REQUEST_SIGNED_FIELDS);

    return {
      url: this.urls.form,
      method: "POST",
      fields: { ...unsigned, signature },
      transactionUuid,
      totalAmount: unsigned.total_amount,
    };
  }

  /** Same as {@link renderPaymentForm}, bound to this client for convenience. */
  renderPaymentForm(request: EpayPaymentRequest, options?: Parameters<typeof renderPaymentForm>[1]): string {
    return renderPaymentForm(request, options);
  }

  /**
   * Decodes the `data` eSewa appends to your success URL and verifies its
   * signature. Throws `SIGNATURE_MISMATCH` if it was tampered with.
   *
   * Accepts the full URL, the query string, a params object (e.g. `req.query`)
   * or the raw base64 string.
   *
   * ⚠️ A valid signature proves eSewa produced the message — it does **not**
   * prove it belongs to *this* order. Prefer {@link confirmPayment}.
   */
  async verifyCallback(input: CallbackInput): Promise<EpayCallback> {
    const data = extractCallbackData(input);

    let json: string;
    let obj: Record<string, unknown>;
    try {
      json = base64ToUtf8(data);
      const parsed: unknown = JSON.parse(json);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
      obj = parsed as Record<string, unknown>;
    } catch (cause) {
      throw new EsewaError("INVALID_RESPONSE", "Callback `data` is not valid base64-encoded JSON", { data }, { cause });
    }

    const signedFieldNames = obj.signed_field_names;
    const signature = obj.signature;
    if (typeof signedFieldNames !== "string" || !signedFieldNames || typeof signature !== "string" || !signature) {
      throw new EsewaError("INVALID_RESPONSE", "Callback is missing signed_field_names or signature", obj);
    }

    const names = signedFieldNames.split(",").map((s) => s.trim());
    const values: Record<string, string> = {};
    for (const name of names) {
      const v = rawJsonValue(json, name, obj[name]);
      if (v === undefined) throw new EsewaError("INVALID_RESPONSE", `Signed field "${name}" missing from callback`, obj);
      values[name] = v;
    }

    const expected = await generateSignature(this.#secretKey, values, names);
    if (!timingSafeEqual(expected, signature)) {
      throw new EsewaError("SIGNATURE_MISMATCH", "eSewa callback signature is invalid", obj);
    }

    const totalAmount = values.total_amount ?? rawJsonValue(json, "total_amount", obj.total_amount) ?? "";
    let totalAmountNormalized = "";
    if (totalAmount) {
      try {
        totalAmountNormalized = formatAmount(totalAmount, "total_amount");
      } catch (cause) {
        throw new EsewaError("INVALID_RESPONSE", `Callback total_amount "${totalAmount}" is not a valid amount`, obj, {
          cause,
        });
      }
    }
    return {
      transactionCode: String(obj.transaction_code ?? ""),
      status: String(obj.status ?? ""),
      totalAmount,
      totalAmountNormalized,
      transactionUuid: String(obj.transaction_uuid ?? ""),
      productCode: String(obj.product_code ?? ""),
      raw: obj,
    };
  }

  /**
   * Asks eSewa for the authoritative state of a transaction. Use it when the
   * redirect never arrived (eSewa recommends after ~5 minutes) and to
   * double-check successful callbacks.
   */
  async checkStatus(params: { transactionUuid: string; totalAmount: Amount }): Promise<EpayStatusResult> {
    if (!params?.transactionUuid) throw new EsewaError("INVALID_PARAMS", "transactionUuid is required");
    const url = new URL(this.urls.status);
    url.searchParams.set("product_code", this.productCode);
    url.searchParams.set("total_amount", formatAmount(params.totalAmount, "totalAmount"));
    url.searchParams.set("transaction_uuid", params.transactionUuid);

    let res: Response;
    try {
      res = await this.#fetch(url, {
        method: "GET",
        headers: { Accept: "application/json" },
        signal: AbortSignal.timeout(this.#timeoutMs),
      });
    } catch (cause) {
      throw new EsewaError("NETWORK_ERROR", `Could not reach eSewa status API: ${(cause as Error)?.message ?? cause}`, {
        url: url.toString(),
      }, { cause });
    }

    const text = await res.text();
    let body: Record<string, unknown> | undefined;
    try {
      const parsed: unknown = text ? JSON.parse(text) : undefined;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) body = parsed as Record<string, unknown>;
    } catch {
      /* handled below */
    }

    if (body && ("error_message" in body || ("code" in body && !("status" in body)))) {
      throw new EsewaError(
        "SERVICE_UNAVAILABLE",
        String(body.error_message ?? "eSewa service is currently unavailable"),
        { httpStatus: res.status, body },
      );
    }
    if (!res.ok) {
      throw new EsewaError("HTTP_ERROR", `eSewa status API responded with HTTP ${res.status}`, {
        httpStatus: res.status,
        body: body ?? text,
      });
    }
    if (!body || typeof body.status !== "string") {
      throw new EsewaError("INVALID_RESPONSE", "Unexpected response from eSewa status API", {
        httpStatus: res.status,
        body: body ?? text,
      });
    }

    return {
      productCode: String(body.product_code ?? this.productCode),
      transactionUuid: String(body.transaction_uuid ?? params.transactionUuid),
      totalAmount: Number(String(body.total_amount ?? "").replace(/,/g, "")),
      status: body.status,
      refId: body.ref_id == null ? null : String(body.ref_id),
      raw: body,
    };
  }

  /**
   * The safe way to handle the success redirect. It:
   * 1. verifies the callback signature,
   * 2. checks product code, transaction UUID and amount against your order,
   * 3. requires status `COMPLETE`,
   * 4. re-confirms with eSewa's status API (server-to-server).
   *
   * Only fulfil the order if this resolves. Throws an {@link EsewaError} otherwise.
   */
  async confirmPayment(input: CallbackInput, options: ConfirmPaymentOptions = {}): Promise<ConfirmedPayment> {
    const callback = await this.verifyCallback(input);

    if (callback.productCode !== this.productCode) {
      throw new EsewaError("INVALID_RESPONSE", "Callback product_code does not match this merchant", callback.raw);
    }
    if (options.expectedTransactionUuid !== undefined && callback.transactionUuid !== options.expectedTransactionUuid) {
      throw new EsewaError("INVALID_RESPONSE", "Callback transaction_uuid does not match the expected order", {
        expected: options.expectedTransactionUuid,
        received: callback.transactionUuid,
      });
    }
    if (options.expectedAmount !== undefined && !amountsEqual(callback.totalAmount, options.expectedAmount)) {
      throw new EsewaError("AMOUNT_MISMATCH", "Paid amount does not match the expected amount", {
        expected: formatAmount(options.expectedAmount),
        received: callback.totalAmount,
      });
    }
    if (callback.status !== "COMPLETE") {
      throw new EsewaError("PAYMENT_NOT_COMPLETE", `Payment status is ${callback.status}`, callback.raw);
    }

    if (options.verifyWithStatusApi === false) return { callback };

    const status = await this.checkStatus({
      transactionUuid: callback.transactionUuid,
      totalAmount: callback.totalAmountNormalized,
    });
    if (status.status !== "COMPLETE") {
      throw new EsewaError("PAYMENT_NOT_COMPLETE", `eSewa status API reports ${status.status}`, status.raw);
    }
    return { callback, status };
  }
}
