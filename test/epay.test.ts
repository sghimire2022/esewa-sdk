import { describe, expect, it, vi } from "vitest";
import {
  ESEWA_TEST_CREDENTIALS,
  EsewaEpay,
  EsewaError,
  formatAmount,
  generateSignature,
  renderPaymentForm,
} from "../src/index.js";

const { productCode, secretKey } = ESEWA_TEST_CREDENTIALS;
const urls = { successUrl: "https://example.com/success", failureUrl: "https://example.com/failure" };

function b64(obj: unknown | string) {
  return Buffer.from(typeof obj === "string" ? obj : JSON.stringify(obj)).toString("base64");
}

// Callback example from https://developer.esewa.com.np/pages/Epay (signature verified against the docs).
const DOC_CALLBACK = {
  transaction_code: "000AWEO",
  status: "COMPLETE",
  total_amount: "1000.0",
  transaction_uuid: "250610-162413",
  product_code: "EPAYTEST",
  signed_field_names: "transaction_code,status,total_amount,transaction_uuid,product_code,signed_field_names",
  signature: "62GcfZTmVkzhtUeh+QJ1AqiJrjoWWGof3U+eTPTZ7fA=",
};

function mockFetch(body: unknown, status = 200) {
  return vi.fn(async () => new Response(typeof body === "string" ? body : JSON.stringify(body), { status }));
}

describe("signature", () => {
  it("matches the request example in eSewa's docs", async () => {
    const sig = await generateSignature(secretKey, {
      total_amount: "110",
      transaction_uuid: "241028",
      product_code: "EPAYTEST",
    });
    expect(sig).toBe("i94zsd3oXF6ZsSr/kGqT4sSzYQzjj1W/waxjWyRwaME=");
  });
});

describe("amounts", () => {
  it("normalises formats", () => {
    expect(formatAmount(100)).toBe("100");
    expect(formatAmount("1,000.0")).toBe("1000");
    expect(formatAmount(10.5)).toBe("10.5");
    expect(formatAmount("10.05")).toBe("10.05");
    expect(formatAmount(0.1 + 0.2)).toBe("0.3");
  });
  it("rejects bad amounts", () => {
    expect(() => formatAmount(-1)).toThrow(EsewaError);
    expect(() => formatAmount("abc")).toThrow(EsewaError);
    expect(() => formatAmount(1.234)).toThrow(EsewaError);
    expect(() => formatAmount(Number.NaN)).toThrow(EsewaError);
  });
});

describe("EsewaEpay.createPayment", () => {
  const esewa = new EsewaEpay({ productCode, secretKey, ...urls });

  it("reproduces the documented form exactly", async () => {
    const p = await esewa.createPayment({
      amount: 100,
      taxAmount: 10,
      transactionUuid: "241028",
      successUrl: "https://developer.esewa.com.np/success",
      failureUrl: "https://developer.esewa.com.np/failure",
    });
    expect(p.url).toBe("https://rc-epay.esewa.com.np/api/epay/main/v2/form");
    expect(p.fields).toEqual({
      amount: "100",
      tax_amount: "10",
      total_amount: "110",
      transaction_uuid: "241028",
      product_code: "EPAYTEST",
      product_service_charge: "0",
      product_delivery_charge: "0",
      success_url: "https://developer.esewa.com.np/success",
      failure_url: "https://developer.esewa.com.np/failure",
      signed_field_names: "total_amount,transaction_uuid,product_code",
      signature: "i94zsd3oXF6ZsSr/kGqT4sSzYQzjj1W/waxjWyRwaME=",
    });
  });

  it("sums charges without float drift and generates a uuid", async () => {
    const p = await esewa.createPayment({ amount: 0.1, taxAmount: 0.2, serviceCharge: "1.05", deliveryCharge: 50 });
    expect(p.fields.total_amount).toBe("51.35");
    expect(p.transactionUuid).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("uses production URLs", async () => {
    const live = new EsewaEpay({ productCode: "X", secretKey: "k", environment: "production", ...urls });
    expect((await live.createPayment({ amount: 1 })).url).toBe("https://epay.esewa.com.np/api/epay/main/v2/form");
  });

  it("validates input", async () => {
    await expect(esewa.createPayment({ amount: 0 })).rejects.toMatchObject({ code: "INVALID_PARAMS" });
    await expect(esewa.createPayment({ amount: 1, transactionUuid: "a_b" })).rejects.toMatchObject({
      code: "INVALID_PARAMS",
    });
    const noUrls = new EsewaEpay({ productCode, secretKey });
    await expect(noUrls.createPayment({ amount: 1 })).rejects.toMatchObject({ code: "INVALID_PARAMS" });
    expect(() => new EsewaEpay({ productCode: "", secretKey })).toThrow(EsewaError);
  });

  it("renders an escaped auto-submit form", async () => {
    const p = await esewa.createPayment({ amount: 1, successUrl: 'https://x.com/?a="><script>', failureUrl: urls.failureUrl });
    const html = renderPaymentForm(p, { nonce: "abc" });
    expect(html).toContain('action="https://rc-epay.esewa.com.np/api/epay/main/v2/form"');
    expect(html).toContain('name="signature"');
    expect(html).toContain('<script nonce="abc">');
    expect(html).not.toContain('"><script>');
  });
});

describe("EsewaEpay.verifyCallback", () => {
  const esewa = new EsewaEpay({ productCode, secretKey });

  it("verifies the documented callback in every input shape", async () => {
    const data = b64(DOC_CALLBACK);
    for (const input of [
      data,
      `?data=${encodeURIComponent(data)}`,
      `https://shop.com/success?data=${encodeURIComponent(data)}`,
      new URL(`https://shop.com/success?data=${encodeURIComponent(data)}`),
      new URLSearchParams({ data }),
      { data },
    ]) {
      const cb = await esewa.verifyCallback(input);
      expect(cb).toMatchObject({
        transactionCode: "000AWEO",
        status: "COMPLETE",
        totalAmount: "1000.0",
        totalAmountNormalized: "1000",
        transactionUuid: "250610-162413",
        productCode: "EPAYTEST",
      });
    }
  });

  it("keeps raw number formatting (1000.0) when the amount is a JSON number", async () => {
    const json = JSON.stringify(DOC_CALLBACK).replace('"total_amount":"1000.0"', '"total_amount":1000.0');
    expect(json).toContain('"total_amount":1000.0');
    const cb = await esewa.verifyCallback(b64(json));
    expect(cb.totalAmount).toBe("1000.0");
  });

  it("verifies comma-formatted amounts", async () => {
    const fields = "transaction_code,status,total_amount,transaction_uuid,product_code,signed_field_names";
    const payload = { ...DOC_CALLBACK, total_amount: "1,000.0", signed_field_names: fields };
    const msg = fields.split(",").map((f) => `${f}=${(payload as Record<string, string>)[f]}`).join(",");
    const { hmacSha256Base64 } = await import("../src/crypto.js");
    payload.signature = await hmacSha256Base64(secretKey, msg);
    const cb = await esewa.verifyCallback(b64(payload));
    expect(cb.totalAmountNormalized).toBe("1000");
  });

  it("rejects a tampered amount", async () => {
    const data = b64({ ...DOC_CALLBACK, total_amount: "1.0" });
    await expect(esewa.verifyCallback(data)).rejects.toMatchObject({ code: "SIGNATURE_MISMATCH" });
  });

  it("rejects a wrong key", async () => {
    const other = new EsewaEpay({ productCode, secretKey: "wrong" });
    await expect(other.verifyCallback(b64(DOC_CALLBACK))).rejects.toMatchObject({ code: "SIGNATURE_MISMATCH" });
  });

  it("rejects garbage", async () => {
    await expect(esewa.verifyCallback("not-base64!!")).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
    await expect(esewa.verifyCallback(b64({ status: "COMPLETE" }))).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
    await expect(esewa.verifyCallback({})).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
  });
});

describe("EsewaEpay.checkStatus", () => {
  it("calls the right URL and maps the response", async () => {
    const fetch = mockFetch({
      product_code: "EPAYTEST",
      transaction_uuid: "123",
      total_amount: 100.0,
      status: "COMPLETE",
      ref_id: "0001TS9",
    });
    const esewa = new EsewaEpay({ productCode, secretKey, fetch });
    const res = await esewa.checkStatus({ transactionUuid: "123", totalAmount: "100.0" });
    expect(res).toMatchObject({ status: "COMPLETE", refId: "0001TS9", totalAmount: 100 });
    const url = String((fetch.mock.calls[0] as unknown[])[0]);
    expect(url).toBe(
      "https://rc.esewa.com.np/api/epay/transaction/status/?product_code=EPAYTEST&total_amount=100&transaction_uuid=123",
    );
  });

  it("maps PENDING with null ref_id", async () => {
    const esewa = new EsewaEpay({
      productCode,
      secretKey,
      fetch: mockFetch({ product_code: "EPAYTEST", transaction_uuid: "1", total_amount: 1, status: "PENDING", ref_id: null }),
    });
    expect(await esewa.checkStatus({ transactionUuid: "1", totalAmount: 1 })).toMatchObject({
      status: "PENDING",
      refId: null,
    });
  });

  it("surfaces 'Service is currently unavailable'", async () => {
    const esewa = new EsewaEpay({
      productCode,
      secretKey,
      fetch: mockFetch({ code: 0, error_message: "Service is currently unavailable" }, 400),
    });
    await expect(esewa.checkStatus({ transactionUuid: "1", totalAmount: 1 })).rejects.toMatchObject({
      code: "SERVICE_UNAVAILABLE",
    });
  });

  it("surfaces HTTP and network errors", async () => {
    const http = new EsewaEpay({ productCode, secretKey, fetch: mockFetch("<html>oops</html>", 502) });
    await expect(http.checkStatus({ transactionUuid: "1", totalAmount: 1 })).rejects.toMatchObject({ code: "HTTP_ERROR" });
    const net = new EsewaEpay({
      productCode,
      secretKey,
      fetch: vi.fn(async () => {
        throw new TypeError("fetch failed");
      }),
    });
    await expect(net.checkStatus({ transactionUuid: "1", totalAmount: 1 })).rejects.toMatchObject({
      code: "NETWORK_ERROR",
    });
  });
});

describe("EsewaEpay.confirmPayment", () => {
  const complete = {
    product_code: "EPAYTEST",
    transaction_uuid: "250610-162413",
    total_amount: 1000,
    status: "COMPLETE",
    ref_id: "000AWEO",
  };

  it("confirms a valid, complete payment", async () => {
    const fetch = mockFetch(complete);
    const esewa = new EsewaEpay({ productCode, secretKey, fetch });
    const res = await esewa.confirmPayment(b64(DOC_CALLBACK), {
      expectedAmount: 1000,
      expectedTransactionUuid: "250610-162413",
    });
    expect(res.status?.status).toBe("COMPLETE");
    expect(String((fetch.mock.calls[0] as unknown[])[0])).toContain("total_amount=1000&");
  });

  it("rejects amount and uuid mismatches", async () => {
    const esewa = new EsewaEpay({ productCode, secretKey, fetch: mockFetch(complete) });
    await expect(esewa.confirmPayment(b64(DOC_CALLBACK), { expectedAmount: 2000 })).rejects.toMatchObject({
      code: "AMOUNT_MISMATCH",
    });
    await expect(
      esewa.confirmPayment(b64(DOC_CALLBACK), { expectedTransactionUuid: "other" }),
    ).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
  });

  it("rejects when the status API disagrees", async () => {
    const esewa = new EsewaEpay({ productCode, secretKey, fetch: mockFetch({ ...complete, status: "AMBIGUOUS" }) });
    await expect(esewa.confirmPayment(b64(DOC_CALLBACK))).rejects.toMatchObject({ code: "PAYMENT_NOT_COMPLETE" });
  });

  it("can skip the status API", async () => {
    const fetch = mockFetch(complete);
    const esewa = new EsewaEpay({ productCode, secretKey, fetch });
    const res = await esewa.confirmPayment(b64(DOC_CALLBACK), { verifyWithStatusApi: false });
    expect(res.status).toBeUndefined();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("rejects another merchant's callback", async () => {
    const esewa = new EsewaEpay({ productCode: "OTHER", secretKey, fetch: mockFetch(complete) });
    await expect(esewa.confirmPayment(b64(DOC_CALLBACK))).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
  });
});
