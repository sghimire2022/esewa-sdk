import "./env.js";

import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import express from "express";
import { ESEWA_TEST_CREDENTIALS, isEsewaError } from "esewa-sdk";
import type { CartLine, CheckoutResponse } from "../shared/types.js";
import { APP_URL, esewa } from "./esewa.js";
import { createOrder, getOrder, markFailed, markPaid } from "./orders.js";

const app = express();
const PORT = Number(process.env.PORT ?? 3000);

app.use(express.json());

app.get("/api/config", (_req, res) => {
  // secretKey never leaves the server, even the public test one: the habit matters more than the value.
  const { esewaIds, password, otp } = ESEWA_TEST_CREDENTIALS;
  res.json({
    environment: esewa.environment,
    productCode: esewa.productCode,
    testCredentials: esewa.environment === "test" ? { esewaIds, password, otp } : null,
  });
});

/* -------------------------------------------------------------------------- */
/* 1. Start a payment                                                         */
/*    Browser → POST /api/checkout { items: [{ productId, quantity }] }      */
/*    The server creates the order and signs the eSewa request.               */
/* -------------------------------------------------------------------------- */
app.post("/api/checkout", async (req, res) => {
  let order;
  try {
    order = createOrder((req.body?.items ?? []) as CartLine[]);
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
    return;
  }

  // The SDK computes total_amount, generates the HMAC signature and returns
  // the exact form eSewa expects. The order id doubles as transaction_uuid,
  // which is how we find the order again when eSewa redirects the customer back.
  const payment = await esewa.createPayment({
    amount: order.totalAmount,
    transactionUuid: order.id,
    successUrl: `${APP_URL}/api/esewa/success`,
    failureUrl: `${APP_URL}/api/esewa/failure/${order.id}`,
  });

  const body: CheckoutResponse = { order, esewa: { url: payment.url, fields: { ...payment.fields } } };
  res.json(body);
});

/* -------------------------------------------------------------------------- */
/* 2. eSewa sends the customer back after a successful payment                */
/*    GET /api/esewa/success?data=<base64 JSON signed by eSewa>               */
/* -------------------------------------------------------------------------- */
app.get("/api/esewa/success", async (req, res) => {
  const callbackUrl = new URL(req.originalUrl, APP_URL);

  // Decode + verify the signature first, only to learn which order this is.
  let orderId: string;
  try {
    orderId = (await esewa.verifyCallback(callbackUrl)).transactionUuid;
  } catch (err) {
    console.error("[esewa] bad callback", isEsewaError(err) ? err.code : err);
    res.redirect(`${APP_URL}/`);
    return;
  }

  const order = getOrder(orderId);
  if (!order) {
    console.error("[esewa] callback for unknown order", orderId);
    res.redirect(`${APP_URL}/`);
    return;
  }

  try {
    // Never mark an order paid just because this URL was hit; anyone can type
    // it into a browser. confirmPayment() checks the signature, that the
    // amount and transaction belong to this order, that the status is
    // COMPLETE, and re-confirms with eSewa's status API server-to-server.
    const { status, callback } = await esewa.confirmPayment(callbackUrl, {
      expectedAmount: order.totalAmount,
      expectedTransactionUuid: order.id,
    });
    markPaid(order, status?.refId ?? callback.transactionCode);
  } catch (err) {
    console.error("[esewa] could not confirm payment", isEsewaError(err) ? err.code : err);
    // Left pending, not failed: a network blip while confirming doesn't mean
    // the customer didn't pay. The order page's "Ask eSewa" button settles it.
  }
  res.redirect(`${APP_URL}/orders/${order.id}`);
});

/* -------------------------------------------------------------------------- */
/* 3. eSewa sends the customer here if they cancel or the session expires     */
/* -------------------------------------------------------------------------- */
app.get("/api/esewa/failure/:orderId", (req, res) => {
  const order = getOrder(req.params.orderId);
  if (order) markFailed(order);
  res.redirect(`${APP_URL}/orders/${req.params.orderId}`);
});

/* -------------------------------------------------------------------------- */
/* 4. Order status, so the order page can show what happened                  */
/* -------------------------------------------------------------------------- */
app.get("/api/orders/:id", (req, res) => {
  const order = getOrder(req.params.id);
  if (!order) {
    res.status(404).json({ error: "Order not found" });
    return;
  }
  res.json(order);
});

/* -------------------------------------------------------------------------- */
/* 5. If the customer closed the tab after paying, the redirect never         */
/*    arrives. Ask eSewa directly. In production, also run this from a       */
/*    scheduled job for anything pending more than ~5 minutes.                */
/* -------------------------------------------------------------------------- */
app.post("/api/orders/:id/check-status", async (req, res) => {
  const order = getOrder(req.params.id);
  if (!order) {
    res.status(404).json({ error: "Order not found" });
    return;
  }
  try {
    const result = await esewa.checkStatus({ transactionUuid: order.id, totalAmount: order.totalAmount });
    if (result.status === "COMPLETE") markPaid(order, result.refId ?? "UNKNOWN");
    else if (result.status === "NOT_FOUND" || result.status === "CANCELED") markFailed(order);
    res.json(order);
  } catch (err) {
    res.status(502).json({ error: isEsewaError(err) ? err.message : "Could not reach eSewa" });
  }
});

/* -------------------------------------------------------------------------- */
/* Production: serve the built React app from the same origin                 */
/* -------------------------------------------------------------------------- */
const distDir = fileURLToPath(new URL("../dist", import.meta.url));
if (process.env.NODE_ENV === "production" && existsSync(distDir)) {
  app.use(express.static(distDir));
  app.get(/^(?!\/api\/).*/, (_req, res) => res.sendFile(`${distDir}/index.html`));
}

app.listen(PORT, () => {
  console.log(`[server] http://localhost:${PORT}  (eSewa ${esewa.environment}, product ${esewa.productCode})`);
  console.log(`[server] customers are sent back to ${APP_URL}`);
});
