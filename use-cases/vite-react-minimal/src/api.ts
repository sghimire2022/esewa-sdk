// Thin wrappers around the server API. Note what is NOT here: no secret key,
// no signature code. The browser only receives already-signed form fields.
import type { CartLine, CheckoutResponse, Order } from "../shared/types";

export interface Config {
  environment: "test" | "production";
  productCode: string;
  testCredentials: { esewaIds: string[]; password: string; otp: string } | null;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: { "content-type": "application/json", ...init?.headers },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error ?? `Request failed with HTTP ${res.status}`);
  return body as T;
}

export const api = {
  config: () => request<Config>("/api/config"),
  checkout: (items: CartLine[]) => request<CheckoutResponse>("/api/checkout", { method: "POST", body: JSON.stringify({ items }) }),
  order: (id: string) => request<Order>(`/api/orders/${encodeURIComponent(id)}`),
  checkStatus: (id: string) => request<Order>(`/api/orders/${encodeURIComponent(id)}/check-status`, { method: "POST" }),
};

/**
 * Sends the customer to eSewa. ePay v2 is a classic HTML form POST, so we
 * build a hidden form from the already-signed fields and submit it. The
 * browser navigates to eSewa's payment page.
 */
export function submitToEsewa(url: string, fields: Record<string, string>): void {
  const form = document.createElement("form");
  form.method = "POST";
  form.action = url;
  for (const [name, value] of Object.entries(fields)) {
    const input = document.createElement("input");
    input.type = "hidden";
    input.name = name;
    input.value = value;
    form.append(input);
  }
  document.body.append(form);
  form.submit();
}

export const npr = (n: number) => `Rs ${n.toLocaleString("en-IN")}`;
