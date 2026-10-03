import { useState } from "react";
import { DELIVERY_CHARGE, PRODUCTS, VAT_RATE, type CheckoutResponse } from "../../shared/types";
import { api, npr, submitToEsewa } from "../api";
import { FieldTable, TestCredentials, TracePanel } from "../components/Trace";

const ERRORS: Record<string, string> = {
  "invalid-callback": "eSewa's response could not be verified, so no order was updated. Try the payment again.",
  "unknown-order": "eSewa returned a payment for an order this shop doesn't know about.",
};

export function ShopPage({ testMode }: { testMode: boolean }) {
  const [productId, setProductId] = useState(PRODUCTS[0]!.id);
  const [quantity, setQuantity] = useState(1);
  const [pause, setPause] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [prepared, setPrepared] = useState<CheckoutResponse | null>(null);

  const product = PRODUCTS.find((p) => p.id === productId)!;
  // Display-only estimate. The server recalculates the real total.
  const amount = product.price * quantity;
  const tax = Math.round(amount * VAT_RATE * 100) / 100;
  const total = Math.round((amount + tax + DELIVERY_CHARGE) * 100) / 100;

  const redirectError = new URLSearchParams(location.search).get("error");

  async function pay() {
    setBusy(true);
    setError(null);
    try {
      const res = await api.checkout(productId, quantity);
      if (pause) {
        setPrepared(res);
        setBusy(false);
      } else {
        submitToEsewa(res.esewa.url, res.esewa.fields);
      }
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  }

  return (
    <main className="layout">
      <section className="shop" aria-labelledby="shop-heading">
        <h1 id="shop-heading" className="display">
          Pick a tea,
          <br />
          pay with eSewa.
        </h1>

        {redirectError && (
          <p className="alert" role="alert">
            {ERRORS[redirectError] ?? "Something went wrong with the payment."}
          </p>
        )}

        <fieldset className="menu" disabled={!!prepared}>
          <legend>Tea</legend>
          {PRODUCTS.map((p) => (
            <label key={p.id} className="menu-item">
              <input
                type="radio"
                name="product"
                value={p.id}
                checked={p.id === productId}
                onChange={() => setProductId(p.id)}
              />
              <span className="menu-name">{p.name}</span>
              <span className="menu-price">
                {npr(p.price)} <small>{p.weight}</small>
              </span>
              <span className="menu-origin">{p.origin}</span>
              <span className="menu-note">{p.note}</span>
            </label>
          ))}
        </fieldset>

        <div className="qty">
          <label htmlFor="qty">Quantity</label>
          <div className="stepper">
            <button
              type="button"
              aria-label="One fewer"
              disabled={quantity <= 1 || !!prepared}
              onClick={() => setQuantity((q) => q - 1)}
            >
              −
            </button>
            <input
              id="qty"
              inputMode="numeric"
              value={quantity}
              disabled={!!prepared}
              onChange={(e) => setQuantity(Math.min(20, Math.max(1, Number(e.target.value) || 1)))}
            />
            <button
              type="button"
              aria-label="One more"
              disabled={quantity >= 20 || !!prepared}
              onClick={() => setQuantity((q) => q + 1)}
            >
              +
            </button>
          </div>
        </div>

        <dl className="summary">
          <div>
            <dt>Tea</dt>
            <dd>{npr(amount)}</dd>
          </div>
          <div>
            <dt>VAT 13%</dt>
            <dd>{npr(tax)}</dd>
          </div>
          <div>
            <dt>Delivery in the valley</dt>
            <dd>{npr(DELIVERY_CHARGE)}</dd>
          </div>
          <div className="summary-total">
            <dt>Total</dt>
            <dd>{npr(total)}</dd>
          </div>
        </dl>

        {!prepared && (
          <>
            <button className="pay" type="button" onClick={pay} disabled={busy}>
              {busy ? "Preparing payment…" : `Pay ${npr(total)} with eSewa`}
            </button>
            <label className="toggle">
              <input type="checkbox" checked={pause} onChange={(e) => setPause(e.target.checked)} />
              Show the signed request before going to eSewa
            </label>
          </>
        )}
        {error && (
          <p className="alert" role="alert">
            {error}
          </p>
        )}
      </section>

      <TracePanel title={prepared ? "Ready to send" : "How this checkout works"}>
        {prepared ? (
          <>
            <p>
              The server created order <strong>{prepared.order.id}</strong> and signed it with your secret key. The
              browser never sees the key, only these fields.
            </p>
            <FieldTable fields={prepared.esewa.fields} />
            <p className="trace-url">
              POST <span>{prepared.esewa.url}</span>
            </p>
            {testMode && <TestCredentials />}
            <div className="trace-actions">
              <button
                className="pay"
                type="button"
                onClick={() => submitToEsewa(prepared.esewa.url, prepared.esewa.fields)}
              >
                Continue to eSewa
              </button>
              <button className="ghost" type="button" onClick={() => setPrepared(null)}>
                Change order
              </button>
            </div>
          </>
        ) : (
          <>
            <ol className="steps">
              <li>
                <code>POST /api/checkout</code> creates the order and calls <code>esewa.createPayment()</code>, which
                returns signed form fields.
              </li>
              <li>The browser posts those fields to eSewa, where the customer logs in and confirms.</li>
              <li>
                eSewa redirects to <code>/api/esewa/success</code>. The server calls{" "}
                <code>esewa.confirmPayment()</code>, which checks the signature, the amount and the status, then asks
                eSewa's status API to be sure.
              </li>
              <li>
                The customer lands on the order page. If the redirect never came back,{" "}
                <code>esewa.checkStatus()</code> settles it.
              </li>
            </ol>
            {testMode && <TestCredentials />}
          </>
        )}
      </TracePanel>
    </main>
  );
}
