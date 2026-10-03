// A deliberately tiny in-memory order store so the example stays focused on eSewa.
// Replace it with your database. The two properties that matter:
//   1. each order has a unique id that you also send to eSewa as transaction_uuid;
//   2. marking an order paid must be idempotent (the same callback can arrive twice).

import { randomBytes } from "node:crypto";
import { DELIVERY_CHARGE, type Order, type OrderEvent, PRODUCTS, VAT_RATE } from "../shared/types.js";

const orders = new Map<string, Order>();

/** Work in paisa so 13% VAT never produces floating point noise. */
const round2 = (n: number) => Math.round(n * 100) / 100;

function newOrderId(): string {
  // eSewa accepts letters, digits and "-" in transaction_uuid.
  const date = new Date().toISOString().slice(2, 10).replace(/-/g, "");
  return `ILAM-${date}-${randomBytes(4).toString("hex").toUpperCase()}`;
}

export function createOrder(productId: string, quantity: number): Order {
  const product = PRODUCTS.find((p) => p.id === productId);
  if (!product) throw new Error("Unknown product");
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > 20) throw new Error("Quantity must be 1–20");

  const amount = product.price * quantity;
  const taxAmount = round2(amount * VAT_RATE);
  const order: Order = {
    id: newOrderId(),
    productId: product.id,
    productName: product.name,
    quantity,
    amount,
    taxAmount,
    deliveryCharge: DELIVERY_CHARGE,
    totalAmount: round2(amount + taxAmount + DELIVERY_CHARGE),
    status: "pending",
    esewaRef: null,
    createdAt: new Date().toISOString(),
    events: [],
  };
  orders.set(order.id, order);
  return order;
}

export function getOrder(id: string): Order | undefined {
  return orders.get(id);
}

export function listOrders(): Order[] {
  return [...orders.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export function logEvent(order: Order, kind: OrderEvent["kind"], text: string, data?: unknown): void {
  order.events.push({ at: new Date().toISOString(), kind, text, ...(data === undefined ? {} : { data }) });
}

/** Idempotent: calling it again for an already-paid order changes nothing. */
export function markPaid(order: Order, esewaRef: string): boolean {
  if (order.status === "paid") return false;
  order.status = "paid";
  order.esewaRef = esewaRef;
  return true;
}
