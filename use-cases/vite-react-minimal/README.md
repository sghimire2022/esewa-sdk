# Use case: cart & checkout with the published `esewa-sdk`

A small cart-and-checkout flow using [`esewa-sdk`](https://www.npmjs.com/package/esewa-sdk) **installed from npm** (not from this repo, unlike [`vite-react-checkout`](../vite-react-checkout) which links the local package while the SDK is in development).

- **Frontend:** Vite + React + TypeScript — pick quantities, pay, see the order status
- **Backend:** Express — the only part that touches the SDK and your secret key

The test eSewa login (ID, password, OTP) is shown right in the app while `ESEWA_ENV=test`, so there's nothing to look up elsewhere.

---

## Quick start

You need Node 20 or newer.

```bash
cd use-cases/vite-react-minimal

# Create your own .env from the template
cp .env.example .env

npm install
npm run dev
```

Open **http://localhost:5173**, set some quantities, and pay. Use the test credentials shown on the page itself. `.env` is optional for this quick start: every value in `.env.example` already defaults to eSewa's public test credentials (`EPAYTEST`) if `.env` is missing or a variable is unset. No real money moves in test mode. You only need to actually edit `.env` once you have your own merchant credentials — see [Configuration](#configuration) below for which variables become required then.

`npm run dev` starts two processes: Vite on port 5173 for the React app, and Express on port 3000 for the API. Vite forwards every `/api/*` request to Express, so the browser only ever talks to `localhost:5173`.

---

## How a payment flows

1. **`POST /api/checkout`** — the server recalculates the total from its own product catalog (never trusts a price from the browser), creates an order, and asks the SDK to sign the request. The order id doubles as eSewa's `transaction_uuid`.
2. **Browser → eSewa** — the already-signed fields are posted to eSewa as a normal HTML form (`submitToEsewa()` in `src/api.ts`).
3. **`GET /api/esewa/success`** — eSewa redirects the customer back with `?data=<base64 JSON>`. `confirmPayment()` checks the signature, that the amount and transaction match this order, that the status is `COMPLETE`, and re-confirms with eSewa's status API server-to-server. Only then is the order marked paid.
4. **`GET /api/esewa/failure/:orderId`** — where eSewa sends the customer if they cancel.
5. **`POST /api/orders/:id/check-status`** — if the customer closes the tab right after paying, the success redirect never arrives. The order page's "Ask eSewa for the status" button calls this directly.

```ts
// server/index.ts
const payment = await esewa.createPayment({
  amount: order.totalAmount,
  transactionUuid: order.id,
  successUrl: `${APP_URL}/api/esewa/success`,
  failureUrl: `${APP_URL}/api/esewa/failure/${order.id}`,
});
```

```ts
// server/index.ts
const { status, callback } = await esewa.confirmPayment(callbackUrl, {
  expectedAmount: order.totalAmount,
  expectedTransactionUuid: order.id,
});
markPaid(order, status?.refId ?? callback.transactionCode);
```

See `server/index.ts` for the full route list, `server/orders.ts` for the in-memory order store, and `shared/types.ts` for the product catalog.

---

## Configuration

```bash
cp .env.example .env
```

Then edit `.env`. Everything is **optional in test mode** — the server falls back to eSewa's public test credentials if a variable is missing. The variables marked below become **required** once you set `ESEWA_ENV=production`.

| Variable | Default | Required in production? | Purpose |
| --- | --- | --- | --- |
| `ESEWA_ENV` | `test` | yes (set to `production`) | `test` uses eSewa's UAT servers; `production` is live money |
| `ESEWA_PRODUCT_CODE` | `EPAYTEST` | **yes** | merchant code issued by eSewa |
| `ESEWA_SECRET_KEY` | test key | **yes** | HMAC secret issued by eSewa; keep it out of the repo |
| `APP_URL` | `http://localhost:5173` | **yes** | public HTTPS URL of the app; eSewa redirects customers here |
| `PORT` | `3000` | no | Express port |

Without real values for the **yes** rows, signatures won't match eSewa's live servers and payments will be rejected — see [Troubleshooting](#troubleshooting).

---

## Going to production

```bash
npm run build                                    # builds the React app into dist/
```

```bash
ESEWA_ENV=production \
ESEWA_PRODUCT_CODE=YOUR_CODE \
ESEWA_SECRET_KEY='your-live-key' \
APP_URL=https://example.com \
NODE_ENV=production \
npm start                                        # Express serves dist/ and /api on one port
```

(On Windows PowerShell, set each value with `$env:VAR = "..."` first, or put them in `.env` — `server/env.ts` loads `.env` before anything reads `process.env`.)

Before taking real payments:

- [ ] Replace `server/orders.ts` (in-memory, lost on restart) with your database.
- [ ] Keep `markPaid` idempotent — eSewa's redirect can arrive more than once, and a refresh replays it (already handled here, keep it that way if you change the store).
- [ ] Set `APP_URL` to your real HTTPS domain.
- [ ] Load `ESEWA_SECRET_KEY` from a secret manager, never from the repo.
- [ ] Schedule `checkStatus` for orders pending more than about five minutes, as eSewa recommends.
- [ ] The test-credentials banner disappears automatically once `ESEWA_ENV` isn't `test` — nothing to remove by hand.

---

## Project layout

```
vite-react-minimal/
├── server/
│   ├── index.ts      All routes: config, checkout, success, failure, order status
│   ├── esewa.ts      The one place the SDK is configured (secret key lives here)
│   ├── orders.ts     In-memory order store: swap for your database
│   └── env.ts        Loads .env before anything reads it
├── shared/
│   └── types.ts      Product catalog and Order type used by both sides
├── src/
│   ├── api.ts         Calls the server; submits the signed form to eSewa
│   ├── App.tsx         Two routes, and the test-credentials banner
│   ├── pages/
│   │   ├── ShopPage.tsx
│   │   └── OrderPage.tsx
│   └── styles.css
├── vite.config.ts     Proxies /api to Express in development
└── .env.example
```

---

## Troubleshooting

**"Cannot find module 'esewa-sdk'"**
Run `npm install` — this example depends on the published package, not a local build.

**eSewa shows an error page right after paying**
The signature didn't match. Check that `ESEWA_PRODUCT_CODE` and `ESEWA_SECRET_KEY` belong together, and that `ESEWA_ENV` matches them. Test keys only work with `test`.

**Order stays "Waiting for confirmation" after paying**
Press **Ask eSewa for the status** on the order page to retry the server-to-server check.

**"Order not found" after restarting the server**
Orders are kept in memory in this example. Use a database in your app.
