// Types and catalog shared by the React app and the Express server.
// Prices live here so the UI can display them, but the server always
// recalculates the total itself from this same list; never trust an
// amount sent by the browser.

export interface Product {
  id: string;
  name: string;
  /** Price per unit, in NPR. */
  price: number;
}

export const PRODUCTS: Product[] = [
  { id: "notebook", name: "Notebook", price: 150 },
  { id: "pen", name: "Pen", price: 40 },
  { id: "mug", name: "Mug", price: 350 },
];

export type OrderStatus = "pending" | "paid" | "failed";

export interface OrderItem {
  productId: string;
  name: string;
  price: number;
  quantity: number;
}

export interface Order {
  /** Also used as eSewa's `transaction_uuid`. */
  id: string;
  items: OrderItem[];
  totalAmount: number;
  status: OrderStatus;
  /** eSewa reference code once paid. */
  refId: string | null;
  createdAt: string;
}

export interface CartLine {
  productId: string;
  quantity: number;
}

/** What POST /api/checkout returns: everything the browser needs to submit the form. */
export interface CheckoutResponse {
  order: Order;
  esewa: {
    url: string;
    fields: Record<string, string>;
  };
}
