import { useEffect, useState } from "react";
import { api } from "./api";
import { OrderPage } from "./pages/OrderPage";
import { ShopPage } from "./pages/ShopPage";
import { navigate } from "./router";

// Two screens, so a router library would be overkill:
//   /             the shop
//   /orders/:id   where the server sends the customer after eSewa

export function App() {
  const [path, setPath] = useState(location.pathname);
  const [env, setEnv] = useState<"test" | "production" | null>(null);

  useEffect(() => {
    const onPop = () => setPath(location.pathname);
    addEventListener("popstate", onPop);
    api.config().then((c) => setEnv(c.environment)).catch(() => setEnv(null));
    return () => removeEventListener("popstate", onPop);
  }, []);

  const orderMatch = /^\/orders\/([^/]+)$/.exec(path);

  return (
    <div className="page">
      <header className="masthead">
        <a
          className="brand"
          href="/"
          onClick={(e) => {
            e.preventDefault();
            navigate("/");
          }}
        >
          Chiya Ghar
        </a>
        <p className="tagline">Single-estate tea from the hills of eastern Nepal</p>
        {env && (
          <span className={`env env-${env}`} title="Set with ESEWA_ENV in .env">
            {env === "test" ? "eSewa test mode" : "eSewa live"}
          </span>
        )}
      </header>

      {orderMatch ? (
        <OrderPage orderId={decodeURIComponent(orderMatch[1]!)} testMode={env === "test"} />
      ) : (
        <ShopPage testMode={env === "test"} />
      )}

      <footer className="footer">
        An example app for <code>esewa-sdk</code>. Payments in test mode use eSewa's sandbox; no real money moves.
      </footer>
    </div>
  );
}
