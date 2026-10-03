import { useEffect, useState } from "react";
import { api, type Config } from "./api";
import { OrderPage } from "./pages/OrderPage";
import { ShopPage } from "./pages/ShopPage";
import { navigate } from "./router";

// Two screens, so a router library would be overkill:
//   /             the shop and cart
//   /orders/:id   where the server sends the customer after eSewa

export function App() {
  const [path, setPath] = useState(location.pathname);
  const [config, setConfig] = useState<Config | null>(null);

  useEffect(() => {
    const onPop = () => setPath(location.pathname);
    addEventListener("popstate", onPop);
    api.config().then(setConfig).catch(() => setConfig(null));
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
          Minimal Shop
        </a>
        <p className="tagline">
          A tiny cart and checkout built with <code>esewa-sdk</code> from npm
        </p>
      </header>

      {config?.testCredentials && <TestCredentials testCredentials={config.testCredentials} />}

      {orderMatch ? (
        <OrderPage orderId={decodeURIComponent(orderMatch[1]!)} />
      ) : (
        <ShopPage />
      )}

      <footer className="footer">
        An example app for <code>esewa-sdk</code>. Payments in test mode use eSewa's sandbox; no real money moves.
      </footer>
    </div>
  );
}

function TestCredentials({ testCredentials }: { testCredentials: Config["testCredentials"] }) {
  if (!testCredentials) return null;
  return (
    <aside className="test-credentials">
      <strong>Test mode &mdash; log in on eSewa's page with:</strong>
      <table>
        <tbody>
          <tr>
            <th>eSewa ID</th>
            <td>{testCredentials.esewaIds.join(", ")}</td>
          </tr>
          <tr>
            <th>Password</th>
            <td>{testCredentials.password}</td>
          </tr>
          <tr>
            <th>OTP</th>
            <td>{testCredentials.otp}</td>
          </tr>
        </tbody>
      </table>
    </aside>
  );
}
