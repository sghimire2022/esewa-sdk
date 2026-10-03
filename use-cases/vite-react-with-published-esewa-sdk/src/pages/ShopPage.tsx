import { useState } from "react";
import { api, npr, submitToEsewa } from "../api";
import { navigate } from "../router";
import { PRODUCTS } from "../../shared/types";

export function ShopPage() {
  const [cart, setCart] = useState<Record<string, number>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const lines = PRODUCTS.map((p) => ({ product: p, quantity: cart[p.id] ?? 0 })).filter((l) => l.quantity > 0);
  const total = lines.reduce((sum, l) => sum + l.product.price * l.quantity, 0);

  function setQuantity(productId: string, quantity: number) {
    setCart((c) => ({ ...c, [productId]: Math.max(0, quantity) }));
  }

  async function checkout() {
    setError(null);
    setBusy(true);
    try {
      const items = lines.map((l) => ({ productId: l.product.id, quantity: l.quantity }));
      const { order, esewa } = await api.checkout(items);
      // Persist nothing client-side: the order id (= transaction_uuid) is how
      // the order page below finds it again after eSewa redirects back.
      navigate(`/orders/${order.id}`);
      submitToEsewa(esewa.url, esewa.fields);
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  }

  return (
    <section className="shop">
      <h1>Pick a few things</h1>
      <ul className="products">
        {PRODUCTS.map((product) => (
          <li key={product.id} className="product">
            <div>
              <strong>{product.name}</strong>
              <span className="price">{npr(product.price)}</span>
            </div>
            <input
              type="number"
              min={0}
              value={cart[product.id] ?? 0}
              onChange={(e) => setQuantity(product.id, Number(e.target.value))}
            />
          </li>
        ))}
      </ul>

      <div className="cart-total">
        <span>Total</span>
        <strong>{npr(total)}</strong>
      </div>

      {error && <p className="status status-failed">{error}</p>}

      <button className="pay-button" disabled={total === 0 || busy} onClick={checkout}>
        {busy ? "Redirecting to eSewa…" : `Pay ${npr(total)} with eSewa`}
      </button>
    </section>
  );
}
