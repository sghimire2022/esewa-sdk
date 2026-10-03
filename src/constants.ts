/** `"test"` targets eSewa's UAT (rc) servers; `"production"` the live ones. */
export type EsewaEnvironment = "test" | "production";

export interface EpayUrls {
  /** URL the customer's browser POSTs the payment form to. */
  form: string;
  /** Transaction status check endpoint. */
  status: string;
}

export const EPAY_URLS: Record<EsewaEnvironment, EpayUrls> = {
  test: {
    form: "https://rc-epay.esewa.com.np/api/epay/main/v2/form",
    status: "https://rc.esewa.com.np/api/epay/transaction/status/",
  },
  production: {
    form: "https://epay.esewa.com.np/api/epay/main/v2/form",
    status: "https://esewa.com.np/api/epay/transaction/status/",
  },
};

/** Fields eSewa requires to be signed on a payment request, in order. */
export const REQUEST_SIGNED_FIELDS = ["total_amount", "transaction_uuid", "product_code"] as const;

/**
 * Public UAT credentials published at https://developer.esewa.com.np/pages/Test-credentials.
 * Only valid with `environment: "test"`. Live credentials are issued by eSewa.
 */
export const ESEWA_TEST_CREDENTIALS = {
  productCode: "EPAYTEST",
  secretKey: "8gBm/:&EnhH.1/q",
  esewaIds: ["9806800001", "9806800002", "9806800003", "9806800004", "9806800005"],
  password: "Nepal@123",
  mpin: "1122",
  otp: "123456",
} as const;
