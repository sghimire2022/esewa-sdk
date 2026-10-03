import "./env.js";

import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import express from "express";
import { createTokenHandler, type EpayStatus, isEsewaError, toNodeHandler } from "esewa-sdk";
import type { CheckoutResponse, Order } from "../shared/types.js";
import { APP_URL, esewa } from "./esewa.js";
import { createOrder, getOrder, listOrders, logEvent, markPaid } from "./orders.js";

const app = express();
const PORT = Number(process.env.PORT ?? 3000);

/* -------------------------------------------------------------------------- */
/* 1. Start a payment                                                         */
/*    Browser → POST /api/checkout { productId, quantity }                    */
/*    Server creates the order, signs the eSewa request, returns the fields.  */
/* -------------------------------------------------------------------------- */
app.post("/api/checkout", express.json(), async (req, res) => {
  let order: Order;
  try {
    order = createOrder(String(req.body?.productId ?? ""), Number(req.body?.quantity ?? 1));
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
    return;
  }

  // The SDK computes total_amount, generates the HMAC signature and returns
  // the exact form eSewa expects. Amounts come from the order, never from the browser.
  const payment = await esewa.createPayment({
    amount: order.amount,
    taxAmount: order.taxAmount,
    deliveryCharge: order.deliveryCharge,
    transactionUuid: order.id,
    // Per-order failure URL so we know which order the customer abandoned.
    // (eSewa appends ?data=... to the success URL, so that one stays query-free.)
    failureUrl: `${APP_URL}/api/esewa/failure/${order.id}`,
  });

  logEvent(order, "info", "Signed payment request created", {
    signed: payment.fields.signed_field_names,
    signature: payment.fields.signature,
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
    console.warn("[esewa] rejected callback:", isEsewaError(err) ? err.code : err);
    res.redirect(`/?error=invalid-callback`);
    return;
  }

  const order = getOrder(orderId);
  if (!order) {
    res.redirect(`/?error=unknown-order`);
    return;
  }
  if (order.status === "paid") {
    // The customer refreshed the page, or eSewa redirected twice. Nothing to do.
    res.redirect(`/orders/${order.id}`);
    return;
  }

  try {
    // The important call: signature, product code, order id, amount,
    // COMPLETE status, then a server-to-server check with eSewa's status API.
    const { callback, status } = await esewa.confirmPayment(callbackUrl, {
      expectedAmount: order.totalAmount,
      expectedTransactionUuid: order.id,
    });
    const ref = status?.refId ?? callback.transactionCode;
    markPaid(order, ref);
    logEvent(order, "ok", "Payment confirmed", {
      signature: "valid",
      amount: `${callback.totalAmount} = ${order.totalAmount}`,
      callbackStatus: callback.status,
      statusApi: status?.status,
      ref,
    });
  } catch (err) {
    if (isEsewaError(err)) {
      // e.g. AMOUNT_MISMATCH, PAYMENT_NOT_COMPLETE, NETWORK_ERROR.
      // The order stays pending; the customer (or a cron job) can re-check later.
      logEvent(order, "error", `Could not confirm payment: ${err.message}`, { code: err.code });
    } else {
      logEvent(order, "error", "Unexpected error while confirming payment");
      console.error(err);
    }
  }
  res.redirect(`/orders/${order.id}`);
});

/* -------------------------------------------------------------------------- */
/* 3. eSewa sends the customer here if they cancel or the payment fails       */
/* -------------------------------------------------------------------------- */
app.get("/api/esewa/failure/:orderId", (req, res) => {
  const order = getOrder(req.params.orderId);
  if (!order) {
    res.redirect("/");
    return;
  }
  if (order.status === "pending") {
    // Don't mark it failed yet: "failure" also covers PENDING payments.
    // The status check below gives the definitive answer.
    logEvent(order, "warn", "Customer returned from eSewa without completing payment");
  }
  res.redirect(`/orders/${order.id}`);
});

/* -------------------------------------------------------------------------- */
/* 4. Ask eSewa directly. Use it for "I paid but the page closed" cases,      */
/*    and run it from a cron job for orders pending > 5 minutes.              */
/* -------------------------------------------------------------------------- */
const STATUS_TO_ORDER: Partial<Record<EpayStatus, Order["status"]>> = {
  NOT_FOUND: "failed",
  CANCELED: "failed",
  FULL_REFUND: "refunded",
  PARTIAL_REFUND: "refunded",
};

app.post("/api/orders/:id/check-status", async (req, res) => {
  const order = getOrder(req.params.id);
  if (!order) {
    res.status(404).json({ error: "Order not found" });
    return;
  }
  try {
    const result = await esewa.checkStatus({ transactionUuid: order.id, totalAmount: order.totalAmount });
    if (result.status === "COMPLETE") {
      markPaid(order, result.refId ?? "");
    } else if (STATUS_TO_ORDER[result.status as EpayStatus]) {
      order.status = STATUS_TO_ORDER[result.status as EpayStatus]!;
    }
    logEvent(order, result.status === "COMPLETE" ? "ok" : "info", `eSewa status API: ${result.status}`, {
      refId: result.refId,
      totalAmount: result.totalAmount,
    });
  } catch (err) {
    logEvent(order, "error", `Status check failed: ${(err as Error).message}`, {
      code: isEsewaError(err) ? err.code : undefined,
    });
  }
  res.json(order);
});

app.get("/api/orders/:id", (req, res) => {
  const order = getOrder(req.params.id);
  if (!order) {
    res.status(404).json({ error: "Order not found" });
    return;
  }
  res.json(order);
});

app.get("/api/orders", (_req, res) => {
  res.json(listOrders());
});

app.get("/api/config", (_req, res) => {
  res.json({ environment: esewa.environment, productCode: esewa.productCode });
});

/* -------------------------------------------------------------------------- */
/* 5. Optional: Token payment                                                 */
/*    The customer types an order id into the eSewa app and eSewa calls       */
/*    these endpoints. Only needed if eSewa enables Token payment for you.    */
/* -------------------------------------------------------------------------- */
const tokenApi = createTokenHandler({
  basePath: "/api/esewa-token",
  auth: {
    type: "basic",
    username: process.env.ESEWA_TOKEN_API_USER ?? "esewa",
    password: process.env.ESEWA_TOKEN_API_PASSWORD ?? "change-me",
  },
  inquiry(requestId) {
    const order = getOrder(requestId);
    if (!order || order.status !== "pending") return { success: false, message: "Invalid token" };
    return {
      success: true,
      amount: order.totalAmount,
      properties: {
        order_id: order.id,
        product_name: `${order.productName} × ${order.quantity}`,
      },
    };
  },
  payment({ requestId, amount, transactionCode }) {
    const order = getOrder(requestId);
    if (!order) return { success: false, message: "Invalid token" };
    if (order.status === "paid" && order.esewaRef === transactionCode) {
      return { success: true, referenceCode: order.id }; // retry of the same payment
    }
    if (order.status !== "pending" || amount !== order.totalAmount) {
      return { success: false, message: "Invalid token" };
    }
    markPaid(order, transactionCode);
    logEvent(order, "ok", "Paid via eSewa Token payment", { transactionCode });
    return { success: true, referenceCode: order.id };
  },
  status({ transactionCode }) {
    const order = listOrders().find((o) => o.esewaRef === transactionCode);
    return order?.status === "paid"
      ? { success: true, status: "SUCCESS", referenceCode: order.id }
      : { success: true, status: "FAILED", message: "Payment Not Found" };
  },
  onError: (err) => console.error("[esewa-token]", err),
});
app.use("/api/esewa-token", express.json(), toNodeHandler(tokenApi));

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
