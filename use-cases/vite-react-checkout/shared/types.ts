// Types and catalog shared by the React app and the Express server.
// Prices live here so the UI can display them, but the server always
// recalculates the total itself; never trust an amount sent by the browser.

export interface Product {
  id: string;
  name: string;
  origin: string;
  note: string;
  /** Price per tin, in NPR. */
  price: number;
  weight: string;
}

export const PRODUCTS: Product[] = [
  {
    id: "ilam-first-flush",
    name: "Ilam first flush",
    origin: "Kanyam estate, Ilam, grown at 1,800 m",
    note: "Picked in March. Light, floral, a little muscatel.",
    price: 850,
    weight: "100 g tin",
  },
  {
    id: "dhankuta-oolong",
    name: "Dhankuta oolong",
    origin: "Hile, Dhankuta, grown at 2,000 m",
    note: "Half-rolled leaves. Toasted honey and stone fruit.",
    price: 1240,
    weight: "75 g tin",
  },
  {
    id: "masala-chiya",
    name: "Masala chiya blend",
    origin: "Assam CTC with Nepali spices",
    note: "Cardamom, ginger, cinnamon. Built for milk and sugar.",
    price: 420,
    weight: "200 g pouch",
  },
];

/** 13% VAT, as charged in Nepal. */
export const VAT_RATE = 0.13;
export const DELIVERY_CHARGE = 100;

export type OrderStatus = "pending" | "paid" | "failed" | "refunded";

export interface OrderEvent {
  at: string;
  kind: "info" | "ok" | "warn" | "error";
  text: string;
  /** Optional structured detail shown in the trace panel. */
  data?: unknown;
}

export interface Order {
  /** Also used as eSewa's `transaction_uuid`. */
  id: string;
  productId: string;
  productName: string;
  quantity: number;
  amount: number;
  taxAmount: number;
  deliveryCharge: number;
  totalAmount: number;
  status: OrderStatus;
  /** eSewa reference code once paid. */
  esewaRef: string | null;
  createdAt: string;
  events: OrderEvent[];
}

/** What POST /api/checkout returns: everything the browser needs to submit the form. */
export interface CheckoutResponse {
  order: Order;
  esewa: {
    url: string;
    fields: Record<string, string>;
  };
}
