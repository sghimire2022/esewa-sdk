import { EsewaError } from "./errors.js";

/** An amount in NPR. Numbers or numeric strings (max 2 decimal places) are accepted. */
export type Amount = number | string;

const AMOUNT_RE = /^\d+(\.\d{1,2})?$/;

/**
 * Converts an amount to integer paisa so arithmetic never suffers from
 * floating point drift (0.1 + 0.2 !== 0.3).
 * Commas are tolerated because eSewa sometimes formats amounts as "1,000.0".
 */
export function toPaisa(value: Amount, field = "amount"): number {
  let n: number;
  if (typeof value === "number") {
    if (!Number.isFinite(value) || value < 0) {
      throw new EsewaError("INVALID_PARAMS", `${field} must be a finite, non-negative number`, { [field]: value });
    }
    n = Math.round(value * 100);
    if (Math.abs(n - value * 100) > 1e-6) {
      throw new EsewaError("INVALID_PARAMS", `${field} may have at most 2 decimal places`, { [field]: value });
    }
  } else if (typeof value === "string") {
    const s = value.replace(/,/g, "").trim();
    if (!AMOUNT_RE.test(s)) {
      throw new EsewaError("INVALID_PARAMS", `${field} must be a non-negative number with at most 2 decimals`, {
        [field]: value,
      });
    }
    const [int, frac = ""] = s.split(".");
    n = Number(int) * 100 + Number(frac.padEnd(2, "0"));
  } else {
    throw new EsewaError("INVALID_PARAMS", `${field} must be a number or numeric string`, { [field]: value });
  }
  if (!Number.isSafeInteger(n)) {
    throw new EsewaError("INVALID_PARAMS", `${field} is too large`, { [field]: value });
  }
  return n;
}

/** Formats paisa as the canonical eSewa string: "100", "100.5", "100.25". */
export function formatPaisa(paisa: number): string {
  const int = Math.trunc(paisa / 100);
  const frac = paisa % 100;
  if (frac === 0) return String(int);
  return `${int}.${String(frac).padStart(2, "0").replace(/0$/, "")}`;
}

/** Normalises any amount to eSewa's canonical string form. */
export function formatAmount(value: Amount, field?: string): string {
  return formatPaisa(toPaisa(value, field));
}

/** True when two amounts are equal to the paisa ("1,000.0" equals 1000). */
export function amountsEqual(a: Amount, b: Amount): boolean {
  return toPaisa(a) === toPaisa(b);
}
