// In-memory order store: swap for a real database before taking real payments.
import { randomUUID } from "node:crypto";
import { PRODUCTS } from "../shared/types.js";
import type { CartLine, Order, OrderItem } from "../shared/types.js";

const orders = new Map<string, Order>();

export function createOrder(cart: CartLine[]): Order {
  if (!Array.isArray(cart) || cart.length === 0) throw new Error("Cart is empty");

  const items: OrderItem[] = cart.map(({ productId, quantity }) => {
    const product = PRODUCTS.find((p) => p.id === productId);
    if (!product) throw new Error(`Unknown product: ${productId}`);
    if (!Number.isInteger(quantity) || quantity < 1) throw new Error(`Invalid quantity for ${productId}`);
    return { productId: product.id, name: product.name, price: product.price, quantity };
  });

  // Recalculated from the catalog above, never from whatever the browser sent.
  const totalAmount = items.reduce((sum, item) => sum + item.price * item.quantity, 0);

  const order: Order = {
    id: randomUUID().toUpperCase(),
    items,
    totalAmount,
    status: "pending",
    refId: null,
    createdAt: new Date().toISOString(),
  };
  orders.set(order.id, order);
  return order;
}

export function getOrder(id: string): Order | undefined {
  return orders.get(id);
}

/** Idempotent: eSewa's redirect can arrive more than once, and a refresh replays it. */
export function markPaid(order: Order, refId: string): void {
  if (order.status === "paid") return;
  order.status = "paid";
  order.refId = refId;
}

export function markFailed(order: Order): void {
  if (order.status === "pending") order.status = "failed";
}
