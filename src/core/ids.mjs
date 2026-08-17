import { randomBytes, randomUUID } from "node:crypto";

/** Create a prefixed opaque identifier suitable for API objects. */
export function createId(prefix) {
  return `${prefix}_${randomUUID().replaceAll("-", "")}`;
}

/** Create a short correlation identifier for logs. */
export function createTraceId() {
  return randomBytes(8).toString("hex");
}
