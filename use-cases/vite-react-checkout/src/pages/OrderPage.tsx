import { useEffect, useState } from "react";
import type { Order } from "../../shared/types";
import { api, npr } from "../api";
import { EventLog, TracePanel } from "../components/Trace";
import { navigate } from "../router";

const HEADLINE: Record<Order["status"], string> = {
  paid: "Paid. Your tea is on its way.",
  pending: "Waiting for confirmation",
  failed: "Payment didn't go through",
  refunded: "Refunded",
};

const EXPLANATION: Record<Order["status"], string> = {
  paid: "eSewa confirmed the payment and the amount matched the order.",
  pending:
    "We haven't confirmed a payment for this order yet. If you completed it on eSewa, ask eSewa for the status below.",
  failed: "eSewa reports this payment as cancelled or expired. No money was taken. You can place the order again.",
  refunded: "eSewa reports this payment as refunded.",
};

export function OrderPage({ orderId, testMode }: { orderId: string; testMode: boolean }) {
  const [order, setOrder] = useState<Order | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);

  useEffect(() => {
    api.order(orderId).then(setOrder, (e: Error) => setError(e.message));
  }, [orderId]);

  async function checkStatus() {
    setChecking(true);
    try {
      setOrder(await api.checkStatus(orderId));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setChecking(false);
    }
  }

  if (error && !order) {
    return (
      <main className="layout layout-single">
        <section className="shop">
          <h1 className="display">Order not found</h1>
          <p>{error}. Orders are kept in memory, so they disappear when the server restarts.</p>
          <button className="ghost" type="button" onClick={() => navigate("/")}>
            Back to the shop
          </button>
        </section>
      </main>
    );
  }
  if (!order) return <main className="layout" aria-busy="true" />;

  return (
    <main className="layout">
      <section className="shop" aria-labelledby="order-heading">
        <p className={`status status-${order.status}`}>{order.id}</p>
        <h1 id="order-heading" className="display">
          {HEADLINE[order.status]}
        </h1>
        <p className="lede">{EXPLANATION[order.status]}</p>

        <dl className="summary">
          <div>
            <dt>
              {order.productName} × {order.quantity}
            </dt>
            <dd>{npr(order.amount)}</dd>
          </div>
          <div>
            <dt>VAT 13%</dt>
            <dd>{npr(order.taxAmount)}</dd>
          </div>
          <div>
            <dt>Delivery</dt>
            <dd>{npr(order.deliveryCharge)}</dd>
          </div>
          <div className="summary-total">
            <dt>Total</dt>
            <dd>{npr(order.totalAmount)}</dd>
          </div>
          {order.esewaRef && (
            <div>
              <dt>eSewa reference</dt>
              <dd className="mono">{order.esewaRef}</dd>
            </div>
          )}
        </dl>

        <div className="actions">
          {order.status !== "paid" && (
            <button className="pay" type="button" onClick={checkStatus} disabled={checking}>
              {checking ? "Asking eSewa…" : "Ask eSewa for the status"}
            </button>
          )}
          <button className="ghost" type="button" onClick={() => navigate("/")}>
            {order.status === "paid" ? "Order more tea" : "Back to the shop"}
          </button>
        </div>
        {testMode && order.status === "pending" && (
          <p className="hint">
            In test mode, eSewa's sandbox only knows about payments you actually completed on its test page. An
            abandoned order reports <code>NOT_FOUND</code> and is marked failed.
          </p>
        )}
      </section>

      <TracePanel title="What happened">
        <EventLog events={order.events} />
      </TracePanel>
    </main>
  );
}
