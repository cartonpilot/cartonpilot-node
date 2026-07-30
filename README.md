# cartonpilot

Official TypeScript SDK for the [CartonPilot](https://cartonpilot.com) 3D bin-packing / cartonization REST API.

- Zero runtime dependencies (uses the global `fetch`; Node.js >= 18)
- Fully typed requests and responses, including batch jobs and webhooks
- Built-in polling for async batch jobs and webhook signature verification

## Install

```bash
npm install cartonpilot
```

You will need an API key. The [free plan](https://cartonpilot.com/pricing) needs no credit card.

## Quickstart (single order)

```ts
import { CartonPilot } from "cartonpilot";

const cartonpilot = new CartonPilot({ apiKey: process.env.CARTONPILOT_API_KEY! });

const result = await cartonpilot.optimize({
  boxes: [
    {
      id: "small-box",
      name: "Small Shipping Box",
      dimensions: { length: 10, width: 8, height: 6 },
      weightCapacity: 20,
      weight: 0.4,
      cost: 5.99,
    },
    {
      id: "medium-box",
      name: "Medium Shipping Box",
      dimensions: { length: 14, width: 12, height: 10 },
      weightCapacity: 35,
      weight: 0.7,
      cost: 8.99,
    },
  ],
  items: [
    {
      id: "item-001",
      name: "Product A",
      dimensions: { length: 4, width: 3, height: 2 },
      weight: 1.5,
      quantity: 2,
    },
  ],
  options: { objective: "fewest-parcels", allowRotation: true },
});

console.log(result.data.summary.totalShipments);
for (const shipment of result.data.shipments) {
  console.log(shipment.box.name, shipment.packedItems.length, "items");
}
```

Instead of inline `boxes`, you can reference a saved box set with `boxSetKey: "bs_..."`, and reference saved catalog items by SKU (`items: [{ sku: "WIDGET-1", quantity: 2 }]` plus `catalogKey: "ic_..."`).

## Client options

```ts
const cartonpilot = new CartonPilot({
  apiKey: "sk_...",                    // required
  baseUrl: "https://cartonpilot.com",     // default
  timeoutMs: 30_000,                   // default; enforced via AbortSignal.timeout
  fetch: customFetch,                  // optional custom fetch implementation
});
```

## Synchronous batch

Up to 50 orders, 100 items per order, 500 total items per request:

```ts
const batch = await cartonpilot.optimize({
  boxSetKey: "bs_abc123xyz456",
  catalogKey: "ic_def789uvw012",
  orders: [
    { orderId: "ORD-001", items: [{ sku: "WIDGET-1", quantity: 2 }] },
    { orderId: "ORD-002", items: [{ sku: "GADGET-7" }] },
  ],
  options: { objective: "fewest-parcels" },
});

console.log(batch.summary.successfulOrders, "of", batch.summary.totalOrders);
for (const order of batch.results) {
  if (!order.success) {
    console.error(order.orderId, "failed:", order.error);
    continue;
  }
  console.log(order.orderId, "->", order.data!.summary.totalShipments, "parcels");
}
```

## Async batch + webhook

Larger batches (up to 500 orders / 5000 total items) run in the background: the API returns `202 Accepted` with a job id. Poll with `waitForBatchJob`, or register a `webhook` to be notified when the job completes or fails.

```ts
const accepted = await cartonpilot.optimize({
  boxSetKey: "bs_abc123xyz456",
  catalogKey: "ic_def789uvw012",
  orders: manyOrders, // up to 500
  async: true,
  webhook: {
    url: "https://example.com/webhooks/cartonpilot",
    secret: process.env.CARTONPILOT_WEBHOOK_SECRET, // enables signature verification
  },
});

console.log(accepted.jobId, accepted.status); // "pending"

// Option A: poll until the job reaches a terminal status
const job = await cartonpilot.waitForBatchJob(accepted.jobId, {
  pollIntervalMs: 2_000, // default
  timeoutMs: 600_000,    // default (10 min); throws if still running
});
if (job.status === "completed") {
  console.log(job.result!.summary);
} else {
  console.error("Job failed:", job.error);
}

// List your 20 most recent jobs (statuses only)
const { jobs } = await cartonpilot.listBatchJobs();
```

### Webhook handler with signature verification (Express)

On completion or failure, CartonPilot POSTs JSON to your URL with headers `X-CartonPilot-Event`, `X-CartonPilot-Job-Id`, and — when you provided a secret — `X-CartonPilot-Signature: sha256=<hex HMAC-SHA256 of the raw body>`. Verify against the **raw** request body:

```ts
import express from "express";
import { verifyWebhookSignature, WebhookPayload } from "cartonpilot";

const app = express();

app.post(
  "/webhooks/cartonpilot",
  express.raw({ type: "application/json" }), // keep the raw body for the HMAC
  (req, res) => {
    const signature = req.header("X-CartonPilot-Signature") ?? "";
    if (!verifyWebhookSignature(req.body, signature, process.env.CARTONPILOT_WEBHOOK_SECRET!)) {
      res.status(401).send("invalid signature");
      return;
    }

    const payload: WebhookPayload = JSON.parse(req.body.toString("utf8"));
    if (payload.event === "batch_job.completed") {
      console.log(`Job ${payload.jobId} done:`, payload.summary);
      // Fetch the full result: cartonpilot.getBatchJob(payload.jobId)
    } else {
      console.error(`Job ${payload.jobId} failed:`, payload.error);
    }
    res.sendStatus(200);
  },
);
```

## Idempotency

Pass an `idempotencyKey` (max 200 characters) to retry safely. Replaying the same key with the same payload returns the stored response without consuming quota; reusing the key with a different payload throws `CartonPilotError` with code `idempotency_conflict` (HTTP 409). Keys expire after 24 hours.

```ts
const result = await cartonpilot.optimize(
  { boxes, items, options: { objective: "lowest-cost" } },
  { idempotencyKey: `order-12345-attempt-1` },
);
```

## Rate cards & lowest-invoice-cost

Upload your negotiated carrier rates (zone × weight table, DIM divisor, max package weight, overweight surcharge) via the `/api/rate-cards` endpoints, then optimize against your actual freight costs. A zone is required — either `options.zone` or a per-order `zone` on every batch order:

```ts
const batch = await cartonpilot.optimize({
  boxSetKey: "bs_abc123xyz456",
  catalogKey: "ic_def789uvw012",
  orders: [
    { orderId: "ORD-001", zone: "4", items: [{ sku: "WIDGET-1", quantity: 2 }] },
    { orderId: "ORD-002", zone: "7", items: [{ sku: "GADGET-7" }] },
  ],
  options: { objective: "lowest-invoice-cost", rateCardKey: "rc_ups2026ground" },
});

// Per-shipment invoice estimates and batch totals:
const first = batch.results[0].data!.shipments[0];
console.log(first.billing?.billableWeight, first.billing?.invoice?.total);
console.log(batch.summary.totalInvoiceCost, batch.summary.currency);
```

Related: `objective: "lowest-billable-weight"` minimizes carrier billable weight and requires `options.dimDivisor` (e.g. `139` for in/lb, `5000` for cm/kg). Whenever `dimDivisor` is set, each shipment includes a `billing` block (`actualWeight`, `dimWeight`, `billableWeight`) and the summary includes `totalBillableWeight`.

## Error handling

Every non-2xx response throws `CartonPilotError`, carrying the API's error envelope (`{ error: <machine code>, message, requestId?, issues?, ...details }`):

```ts
import { CartonPilot, CartonPilotError } from "cartonpilot";

try {
  await cartonpilot.optimize({ boxes, items });
} catch (err) {
  if (err instanceof CartonPilotError) {
    switch (err.code) {
      case "invalid_request":
        // err.issues: [{ path: "options.dimDivisor", message: "..." }, ...]
        console.error("Validation failed:", err.issues);
        break;
      case "quota_exceeded":
        // Extra detail fields are on err.body (e.g. itemsRemaining, resetAt)
        console.error("Monthly quota exhausted:", err.message);
        break;
      case "authentication_failed":
      case "endpoint_not_allowed":
      case "algorithm_not_allowed":
      case "limit_exceeded":
      case "idempotency_conflict":
      case "not_found":
      default:
        console.error(err.status, err.code, err.message, err.requestId);
    }
  } else {
    throw err; // network error, timeout (AbortSignal), etc.
  }
}
```

## Narrowing `optimize` results

`optimize` is overloaded, so with a statically-known request shape the return type is precise. If you build requests dynamically, narrow with the exported type guards:

```ts
import { isBatchJobAccepted, isBatchResponse, isOptimizationResponse } from "cartonpilot";

const response = await cartonpilot.optimize(dynamicRequest);
if (isBatchJobAccepted(response)) {
  await cartonpilot.waitForBatchJob(response.jobId);
} else if (isBatchResponse(response)) {
  console.log(response.summary.totalOrders);
} else if (isOptimizationResponse(response)) {
  console.log(response.data.summary.totalShipments);
}
```

## Development

```bash
npm run typecheck  # tsc --noEmit
npm run build      # emit dist/
```
