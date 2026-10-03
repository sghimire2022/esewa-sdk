import { useEffect, useState } from "react";
import { api, npr } from "../api";
import { navigate } from "../router";
import type { Order } from "../../shared/types";

const STATUS_TEXT: Record<Order["status"], { text: string; className: string }> = {
  paid: { text: "Paid", className: "status status-paid" },
  failed: { text: "Failed or cancelled", className: "status status-failed" },
  pending: { text: "Waiting for confirmation", className: "status status-cancelled" },
};

export function OrderPage({ orderId }: { orderId: string }) {
  const [order, setOrder] = useState<Order | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);

  useEffect(() => {
    api.order(orderId).then(setOrder).catch((err) => setError((err as Error).message));
  }, [orderId]);

  async function checkStatus() {
    setChecking(true);
    try {
      setOrder(await api.checkStatus(orderId));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setChecking(false);
    }
  }

  if (error) return <p className="status status-failed">{error}</p>;
  if (!order) return <p>Loading order…</p>;

  const status = STATUS_TEXT[order.status];

  return (
    <section className="order">
      <h1>Order {order.id}</h1>
      <p className={status.className}>{status.text}</p>

      <ul className="order-items">
        {order.items.map((item) => (
          <li key={item.productId}>
            {item.quantity} × {item.name} ({npr(item.price)} each)
          </li>
        ))}
      </ul>
      <div className="cart-total">
        <span>Total</span>
        <strong>{npr(order.totalAmount)}</strong>
      </div>
      {order.refId && <p>eSewa reference: {order.refId}</p>}

      {order.status === "pending" && (
        <button className="pay-button" disabled={checking} onClick={checkStatus}>
          {checking ? "Asking eSewa…" : "Ask eSewa for the status"}
        </button>
      )}

      <p>
        <a
          href="/"
          onClick={(e) => {
            e.preventDefault();
            navigate("/");
          }}
        >
          Back to shop
        </a>
      </p>
    </section>
  );
}
