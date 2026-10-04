# esewa-sdk

Unofficial, type-safe TypeScript SDK for the [eSewa](https://esewa.com.np) payment gateway.

- **ePay v2**: signed checkout, callback verification, status check, and a one-call `confirmPayment()` that does all the safety checks for you
- **Token payment**: a ready-made API for eSewa to call (inquiry, payment, status, access-token) with Basic or Bearer auth
- **Zero dependencies**: uses Web Crypto and `fetch`, so it runs on Node 18+, Bun, Deno, Cloudflare Workers and Vercel Edge
- ESM + CommonJS, full `.d.ts` types, typed errors

> Not affiliated with eSewa / F1Soft. API reference: <https://developer.esewa.com.np>

```bash
npm install esewa-sdk
```

---

## ePay v2

ePay is a redirect flow: your server signs a payment, the customer's browser POSTs it to eSewa, they pay, and eSewa redirects back to your `success_url` with a signed `?data=` payload.

> ⚠️ Run this on your **server**. It needs your secret key, which must never reach the browser.

### 1. Create the client

```ts
import { EsewaEpay, ESEWA_TEST_CREDENTIALS } from "esewa-sdk";

export const esewa = new EsewaEpay({
  productCode: process.env.ESEWA_PRODUCT_CODE ?? ESEWA_TEST_CREDENTIALS.productCode, // "EPAYTEST"
  secretKey: process.env.ESEWA_SECRET_KEY ?? ESEWA_TEST_CREDENTIALS.secretKey,
  environment: process.env.NODE_ENV === "production" ? "production" : "test",
  successUrl: "https://shop.example.com/payments/esewa/success",
  failureUrl: "https://shop.example.com/payments/esewa/failure",
});
```

### 2. Start a payment

```ts
const payment = await esewa.createPayment({
  amount: 100,          // product price
  taxAmount: 13,        // optional
  serviceCharge: 0,     // optional
  deliveryCharge: 50,   // optional
  transactionUuid: order.id, // optional; letters, digits and "-" only; a UUID is generated if omitted
});

// Persist payment.transactionUuid + payment.totalAmount against your order, then either:

// a) return an auto-submitting HTML page from your server
return new Response(esewa.renderPaymentForm(payment), { headers: { "content-type": "text/html" } });

// b) or return { url, fields } as JSON and build/submit the form in your frontend
return Response.json({ url: payment.url, fields: payment.fields });
```

Frontend snippet for option (b):

```ts
const { url, fields } = await fetch("/api/checkout", { method: "POST" }).then((r) => r.json());
const form = Object.assign(document.createElement("form"), { method: "POST", action: url });
for (const [name, value] of Object.entries(fields)) {
  form.append(Object.assign(document.createElement("input"), { type: "hidden", name, value }));
}
document.body.append(form);
form.submit();
```

### 3. Handle the success redirect

```ts
import { isEsewaError } from "esewa-sdk";

// GET /payments/esewa/success?data=eyJ0cmFuc2FjdGlvbl9jb2RlIjoi...
export async function GET(req: Request) {
  const url = new URL(req.url);
  try {
    // Signature-checked decode, used only to find which order this is.
    const { transactionUuid } = await esewa.verifyCallback(url);
    const order = await db.orders.findByEsewaUuid(transactionUuid);
    if (!order || order.paid) throw new Error("Unknown or already-paid order");

    const { callback, status } = await esewa.confirmPayment(url, {
      expectedAmount: order.total,
      expectedTransactionUuid: order.esewaUuid,
    });
    await db.orders.markPaid(order.id, { esewaRef: status?.refId ?? callback.transactionCode });
    return Response.redirect("https://shop.example.com/thank-you");
  } catch (err) {
    if (isEsewaError(err)) console.warn("eSewa payment rejected:", err.code, err.message);
    return Response.redirect("https://shop.example.com/payment-failed");
  }
}
```

`confirmPayment()` accepts the full URL, a query string, `URLSearchParams`, a params object (e.g. Express `req.query`) or the raw base64 string. It:

1. decodes `data` and verifies its HMAC-SHA256 signature (constant-time),
2. checks `product_code`, `transaction_uuid` and amount against your order,
3. requires status `COMPLETE`,
4. re-confirms server-to-server with eSewa's status API.

Need just one step? Use `verifyCallback()` or `checkStatus()` directly.

### 4. Reconcile stuck payments

If a customer never comes back (eSewa recommends waiting ~5 minutes), ask eSewa directly:

```ts
const s = await esewa.checkStatus({ transactionUuid: order.esewaUuid, totalAmount: order.total });

switch (s.status) {
  case "COMPLETE":       /* fulfil */ break;
  case "PENDING":        /* try again later */ break;
  case "AMBIGUOUS":      /* hold and contact eSewa */ break;
  case "NOT_FOUND":      /* session expired: mark failed */ break;
  case "CANCELED":
  case "FULL_REFUND":
  case "PARTIAL_REFUND": /* update the order */ break;
}
```

---

## Token payment

In Token payment the customer types *your* token (invoice no., customer ID, ...) into the eSewa app and **eSewa calls your API**. `createTokenHandler()` is that API as a standard Fetch handler.

| Route | Called by eSewa to |
| --- | --- |
| `POST /access-token` | get a Bearer token (bearer auth only) |
| `GET /inquiry/:requestId` | look up what the token is for and how much to pay |
| `POST /payment` | record the payment |
| `POST /status` | ask whether you recorded it |

```ts
import { createTokenHandler } from "esewa-sdk";

export const esewaTokenApi = createTokenHandler({
  basePath: "/api/esewa",
  auth: { type: "basic", username: process.env.ESEWA_API_USER!, password: process.env.ESEWA_API_PASS! },

  async inquiry(requestId) {
    const invoice = await db.invoices.find(requestId);
    if (!invoice || invoice.paid) return { success: false, message: "Invalid token" };
    return {
      success: true,
      amount: invoice.amount,
      properties: { customer_name: invoice.customerName, invoice_number: invoice.number },
      // packages: [{ display: "1 Month [Rs 499]", value: 499, properties: { package_id: 1 } }],
    };
  },

  async payment({ requestId, amount, transactionCode, packageId }) {
    // Must be idempotent on transactionCode: eSewa may retry.
    const invoice = await db.invoices.find(requestId);
    if (!invoice || invoice.amount !== amount) return { success: false, message: "Invalid token" };
    const ref = await db.invoices.markPaidOnce(requestId, transactionCode);
    return { success: true, referenceCode: ref };
  },

  async status({ transactionCode }) {
    const ref = await db.invoices.findRefByEsewaCode(transactionCode);
    return ref
      ? { success: true, status: "SUCCESS", referenceCode: ref }
      : { success: true, status: "FAILED", message: "Payment Not Found" };
  },
});
```

**Bearer auth.** The SDK issues and verifies short-lived, HMAC-signed tokens, so you don't need a JWT library:

```ts
auth: {
  type: "bearer",
  clientSecret: process.env.ESEWA_CLIENT_SECRET!, // shared with eSewa
  username: process.env.ESEWA_API_USER!,
  password: process.env.ESEWA_API_PASS!,
  signingKey: process.env.ESEWA_TOKEN_SIGNING_KEY!, // ≥ 32 random chars, never shared
  accessTokenTtl: 300,
  refreshTokenTtl: 600,
}
```

### Mounting it

```ts
// Next.js App Router: app/api/esewa/[...path]/route.ts
export { esewaTokenApi as GET, esewaTokenApi as POST };

// Hono / Bun / Deno / Cloudflare Workers
app.all("/api/esewa/*", (c) => esewaTokenApi(c.req.raw));

// Express / Node http
import { toNodeHandler } from "esewa-sdk";
app.use("/api/esewa", express.json(), toNodeHandler(esewaTokenApi));
```

---

## Use cases

Complete, runnable example apps live in [`use-cases/`](use-cases):

| Example | Stack | Shows |
| --- | --- | --- |
| [`vite-react-checkout`](use-cases/vite-react-checkout) | Vite + React + Express | ePay v2 checkout, callback verification, status check, Token payment API |
| [`vite-react-with-published-esewa-sdk`](use-cases/vite-react-with-published-esewa-sdk) | Vite + React + Express | Same checkout flow, installing `esewa-sdk` from npm instead of linking this repo |

### Tested with eSewa

A checkout through eSewa's test environment with test ID `9806800005`, using the published package. The [full six-step walkthrough](https://github.com/sghimire2022/esewa-sdk/tree/main/use-cases/vite-react-with-published-esewa-sdk#tested-in-esewas-test-environment) is in the use case's README.

<!-- Full URLs (not relative paths) so the images also render on npmjs.com, whose package doesn't include them. They load once the files are on main. -->

| Shop, with test credentials | eSewa login | Order paid |
| --- | --- | --- |
| ![Shop page with test-credentials banner](https://raw.githubusercontent.com/sghimire2022/esewa-sdk/main/use-cases/vite-react-with-published-esewa-sdk/docs/screenshots/01-shop.png) | ![eSewa login page](https://raw.githubusercontent.com/sghimire2022/esewa-sdk/main/use-cases/vite-react-with-published-esewa-sdk/docs/screenshots/02-esewa-login.png) | ![Order page showing paid](https://raw.githubusercontent.com/sghimire2022/esewa-sdk/main/use-cases/vite-react-with-published-esewa-sdk/docs/screenshots/05-order-paid.png) |

---

## Errors

Everything throws `EsewaError` with a `code`:

| code | meaning |
| --- | --- |
| `INVALID_CONFIG` / `INVALID_PARAMS` | bad config or input |
| `SIGNATURE_MISMATCH` | callback was tampered with or signed with another key |
| `AMOUNT_MISMATCH` | amount paid ≠ amount expected |
| `PAYMENT_NOT_COMPLETE` | status isn't `COMPLETE` |
| `INVALID_RESPONSE` | malformed data, or it belongs to a different merchant/order |
| `SERVICE_UNAVAILABLE` | eSewa says "Service is currently unavailable" |
| `HTTP_ERROR` / `NETWORK_ERROR` | transport problems; safe to retry `checkStatus` |

## Testing

`ESEWA_TEST_CREDENTIALS` holds eSewa's public UAT values:

| | |
| --- | --- |
| Product code | `EPAYTEST` |
| Secret key | `8gBm/:&EnhH.1/q` |
| eSewa ID | `9806800005` (the constant also lists eSewa's other documented IDs, `9806800001`–`04`) |
| Password | `Nepal@123` |
| MPIN | `1122` |
| OTP | `123456` |

Live credentials are issued by eSewa after successful test transactions.

## Notes

- Amounts are handled in integer paisa internally, so `0.1 + 0.2` charges total exactly `0.3`. Up to 2 decimal places are accepted.
- Callback signatures are checked against values exactly as eSewa sent them (e.g. `"1000.0"`, `"1,000.0"`), so they verify reliably.
- **Intent payment** (eSewa's app deeplink flow) isn't included yet; its public docs are incomplete. [PRs welcome](CONTRIBUTING.md).

## Development

```bash
npm install
npm test          # vitest
npm run typecheck
npm run build     # ESM + CJS + .d.ts into dist/
```

## Contributing

Bug reports, feature requests, and PRs are welcome on [github.com/sghimire2022/esewa-sdk](https://github.com/sghimire2022/esewa-sdk) — see [CONTRIBUTING.md](CONTRIBUTING.md) for dev setup, coding conventions, and how to submit a pull request.

## License

MIT
