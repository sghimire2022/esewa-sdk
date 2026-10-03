// The one place the SDK is configured. The secret key lives only here, on
// the server, never in anything shipped to the browser.
import { ESEWA_TEST_CREDENTIALS, EsewaEpay } from "esewa-sdk";

export const APP_URL = process.env.APP_URL ?? "http://localhost:5173";

export const esewa = new EsewaEpay({
  environment: process.env.ESEWA_ENV === "production" ? "production" : "test",
  productCode: process.env.ESEWA_PRODUCT_CODE ?? ESEWA_TEST_CREDENTIALS.productCode,
  secretKey: process.env.ESEWA_SECRET_KEY ?? ESEWA_TEST_CREDENTIALS.secretKey,
});
