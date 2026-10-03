// One place that configures the SDK. Import `esewa` anywhere on the server.
// This file must never be imported by browser code: it holds the secret key.

import { ESEWA_TEST_CREDENTIALS, EsewaEpay, type EsewaEnvironment } from "esewa-sdk";

const environment = (process.env.ESEWA_ENV ?? "test") as EsewaEnvironment;

if (environment === "production" && (!process.env.ESEWA_PRODUCT_CODE || !process.env.ESEWA_SECRET_KEY)) {
  throw new Error("ESEWA_PRODUCT_CODE and ESEWA_SECRET_KEY are required when ESEWA_ENV=production");
}

/** Public URL of this app as the customer's browser sees it. */
export const APP_URL = (process.env.APP_URL ?? "http://localhost:5173").replace(/\/$/, "");

export const esewa = new EsewaEpay({
  environment,
  productCode: process.env.ESEWA_PRODUCT_CODE ?? ESEWA_TEST_CREDENTIALS.productCode,
  secretKey: process.env.ESEWA_SECRET_KEY ?? ESEWA_TEST_CREDENTIALS.secretKey,
  // Where eSewa sends the customer back. These are server routes (see server/index.ts),
  // not React pages: the server must verify the payment before showing anything.
  successUrl: `${APP_URL}/api/esewa/success`,
  failureUrl: `${APP_URL}/api/esewa/failure`,
  // Optional: point the status check at a mock server for offline testing.
  ...(process.env.ESEWA_STATUS_URL ? { urls: { status: process.env.ESEWA_STATUS_URL } } : {}),
});
