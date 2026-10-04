# esewa-sdk — design notes (v0.1.1, 2026-10-03)

Package name: `esewa-sdk` (free on npm as of 2026-10-03). Zero runtime deps; Web Crypto + fetch; ESM + CJS + d.ts via tsup. Tooling pinned to TypeScript 5.9 because TS 7 has no JS compiler API (breaks tsup's dts build).

## Scope
- ePay v2: `EsewaEpay` — createPayment, renderPaymentForm, verifyCallback, checkStatus, confirmPayment.
- Token payment: `createTokenHandler()` Fetch handler (access-token / inquiry / payment / status), Basic or Bearer auth (SDK issues stateless HMAC-signed tokens), `toNodeHandler()` for Express/Node.
- Not yet: Intent payment (developer.esewa.com.np/pages/Intent blocks automated fetch; known endpoints: rc-checkout.esewa.com.np/api/client/intent/payment/{book,status,cancel}, product_code "INTENT"). Deprecated mobile SDKs skipped.

## Use cases
- `use-cases/vite-react-checkout` — Vite + React frontend, Express server. Shows createPayment → form POST → confirmPayment on the success route → checkStatus reconciliation, plus a Token payment API. Depends on the SDK via `file:../..` until published. Has `ESEWA_STATUS_URL` env override for offline testing against a mock status API.
- Design: "Chiya Ghar" tea shop; dark tea-leaf trace panel shows signed fields and per-order verification events.

## Verified facts
- UAT secret key `8gBm/:&EnhH.1/q` reproduces the docs' form signature `i94zsd3o…` (total 110, uuid 241028) and callback signature `62GcfZTm…`.
- The docs' "Input/Result" example (`4Ov7pCI1…`) does NOT reproduce with the published key — treat as stale.
- Callback signature covers `signed_field_names` itself, whose value contains commas; message is a plain `k=v` join with ",".
- Callback amounts must be re-signed exactly as sent ("1000.0", possibly "1,000.0"); SDK extracts raw JSON values for this.
- Two different test eSewa ID sets appear in the docs: 9806800001–5 (Test credentials page) and 9711111111–4 (ePay page).
- 9806800005 (password `Nepal@123`, OTP `123456`) confirmed working in a manual UAT checkout on 2026-10-03.
- eSewa's success redirect appends `?data=`, so keep the success URL query-free; put order ids in the failure URL path instead.

## Changelog
- 0.1.1: verifyCallback restores "+" that a form decoder turned into a space (base64 of ASCII JSON contains "+" only when "~" or ">" falls on a 3-byte boundary, so it's rare but real); a malformed signed amount now throws INVALID_RESPONSE instead of INVALID_PARAMS. 35 tests.
- 0.1.0: initial release.

## Open items
- Live UAT run not done from the build sandbox (network policy blocks esewa.com.np) — run `npm test` + a manual UAT checkout locally before publishing.
- Add Intent payment once full docs are available.
