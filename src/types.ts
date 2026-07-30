/**
 * Type definitions mirroring the CartonPilot v1 REST API.
 *
 * Request shapes follow `src/lib/api-validation.ts` and response shapes follow
 * `src/lib/api-response-formatter.ts` in the CartonPilot service.
 */

// ===== Shared primitives =====

export interface Dimensions {
  length: number;
  width: number;
  height: number;
}

export interface Position {
  x: number;
  y: number;
  z: number;
}

export type BoxType = "standard" | "refrigerated" | "hazmat" | "custom";

// ===== Request types =====

export interface Box {
  id: string;
  name?: string;
  dimensions: Dimensions;
  weightCapacity?: number;
  /** Tare weight of the empty box. */
  weight?: number;
  cost?: number;
  type?: BoxType;
  innerDimensions?: Dimensions;
}

/** A fully inline item definition. */
export interface InlineItem {
  id: string;
  name?: string;
  dimensions: Dimensions;
  weight?: number;
  /** Defaults to 1. */
  quantity?: number;
  fragile?: boolean;
  keepUpright?: boolean;
  stackable?: boolean;
  maxStackWeight?: number;
  value?: number;
  color?: string;
  /** 0-5. Pro/Enterprise plans only (stripped on lower tiers). */
  fragilityLevel?: number;
  /** Pro/Enterprise plans only (stripped on lower tiers). */
  maxTopLoad?: number;
  allowedRotations?: "all" | "horizontal-only" | "none";
}

/**
 * Reference to a SKU stored in a saved item catalog. Requests using SKU refs
 * must also set the top-level `catalogKey`.
 */
export interface SkuRef {
  sku: string;
  /** Defaults to 1. */
  quantity?: number;
}

export type RequestItem = InlineItem | SkuRef;

/** Runtime check matching the server's SKU-reference detection. */
export function isSkuRef(item: RequestItem): item is SkuRef {
  return "sku" in item && !("dimensions" in item);
}

export type Algorithm =
  | "first-fit"
  | "best-fit"
  | "guillotine"
  | "max-rects"
  | "cartonpilot-fit"
  | "cartonpilot-ultra"
  | "cartonpilot-max"
  | "cartonpilot-physics";

export type Objective =
  | "fewest-parcels"
  | "lowest-cost"
  | "lowest-billable-weight"
  | "lowest-invoice-cost"
  | "fastest";

export type Prioritize =
  | "space"
  | "cost"
  | "speed"
  | "consolidation"
  | "billable-weight"
  | "invoice-cost";

export type VisualizationFormat = "data" | "ascii" | "html";

export interface PackingOptions {
  /** Power-user override; prefer `objective`. */
  algorithm?: Algorithm;
  /** Recommended way to pick an algorithm. */
  objective?: Objective;
  allowRotation?: boolean;
  prioritize?: Prioritize;
  /**
   * Carrier DIM divisor (e.g. 139 for in/lb, 5000 for cm/kg). Required for
   * `objective: "lowest-billable-weight"`; enables per-shipment billing
   * figures whenever provided.
   */
  dimDivisor?: number;
  /**
   * Key of a saved rate card (rc_...) for invoice-cost estimation and the
   * "lowest-invoice-cost" objective. Requires a zone (here or per order).
   */
  rateCardKey?: string;
  /** Shipping zone for rate-card lookups; batch orders may override per order. */
  zone?: string | number;
  /** 0-1. */
  consolidationThreshold?: number;
  /** Tier-gated (disabled on the FREE plan). */
  enableVisualization?: boolean;
  /** Defaults to "data". */
  visualizationFormat?: VisualizationFormat;
  paddingBetweenItems?: number;
  /** 0-1. */
  paddingFactor?: number;
  considerFragility?: boolean;
  /** Milliseconds, max 30000. */
  maxComputationTime?: number;
  generateAlternatives?: boolean;
  oversizedItemHandling?: "custom-box" | "unpacked";
  overweightItemHandling?: "allow" | "unpacked";
  maxShipmentWeight?: number;
}

export interface Order {
  orderId: string;
  items: RequestItem[];
  /** Per-order shipping zone; overrides options.zone for rate-card lookups. */
  zone?: string | number;
}

/** Webhook registration for async batch jobs. */
export interface WebhookConfig {
  /** URL that CartonPilot POSTs to when the job completes or fails. */
  url: string;
  /**
   * When provided, deliveries carry an `X-CartonPilot-Signature` header
   * (`sha256=<hex HMAC-SHA256 of the raw body>`). Verify it with
   * {@link verifyWebhookSignature}.
   */
  secret?: string;
}

/**
 * Fields common to all optimize requests. Provide exactly one of
 * `boxes` / `boxSetKey`, and `catalogKey` whenever items use SKU refs.
 */
export interface OptimizeRequestBase {
  boxes?: Box[];
  /** Key of a saved box set (bs_...). Mutually exclusive with `boxes`. */
  boxSetKey?: string;
  /** Key of a saved item catalog (ic_...). Required when using SKU refs. */
  catalogKey?: string;
  options?: PackingOptions;
}

/** Single-order request: returns an {@link OptimizationResponse}. */
export interface SingleOptimizeRequest extends OptimizeRequestBase {
  items: RequestItem[];
  orders?: never;
  async?: never;
  webhook?: never;
}

/**
 * Synchronous batch request (max 50 orders, 100 items/order, 500 total
 * items): returns a {@link BatchResponse}.
 */
export interface BatchOptimizeRequest extends OptimizeRequestBase {
  orders: Order[];
  items?: never;
  async?: false;
  webhook?: never;
}

/**
 * Async batch request (max 500 orders, 100 items/order, 5000 total items):
 * returns 202 with a {@link BatchJobAccepted}; poll or wait for the job, or
 * register a webhook to be notified on completion.
 */
export interface AsyncBatchOptimizeRequest extends OptimizeRequestBase {
  orders: Order[];
  items?: never;
  async: true;
  webhook?: WebhookConfig;
}

export type OptimizeRequest =
  | SingleOptimizeRequest
  | BatchOptimizeRequest
  | AsyncBatchOptimizeRequest;

// ===== Response types =====

/** Rate-card freight estimate attached to a shipment's billing block. */
export interface ShipmentInvoice {
  zone: string;
  baseRate: number;
  overweightFee: number;
  total: number;
  currency: string;
}

/**
 * Carrier billing figures; present when options.dimDivisor or a rate card is
 * provided. `invoice` is present only when a rate card was used.
 */
export interface ShipmentBilling {
  /** Contents plus box tare weight, unrounded. */
  actualWeight: number;
  /** Box volume / dimDivisor, rounded up to the next whole unit. */
  dimWeight: number;
  /** max(actual rounded up, dim weight); what a carrier bills against. */
  billableWeight: number;
  invoice?: ShipmentInvoice;
}

/** Structured placement data returned when options.enableVisualization is set. */
export interface VisualizationData {
  boxDimensions: Dimensions;
  items: Array<{
    id: string;
    name?: string;
    position: Position;
    dimensions: Dimensions;
    color: string;
  }>;
  freeSpaces?: Position[];
}

export interface PackedItem {
  itemId: string;
  itemIndex: number;
  position: Position;
  rotation: { lengthAxis: string; widthAxis: string; heightAxis: string };
  rotatedDimensions: Dimensions;
}

export interface Shipment {
  box: {
    id: string;
    name: string;
    dimensions: Dimensions;
    cost?: number;
    weight?: number;
    type?: BoxType;
  };
  packedItems: PackedItem[];
  utilization: {
    volume: number;
    weight: number;
    efficiency: number;
  };
  /** Weight of packed items only (excludes the box itself). */
  contentsWeight: number;
  /** Contents plus the box tare weight, when `box.weight` is provided. */
  totalWeight: number;
  billing?: ShipmentBilling;
  totalValue?: number;
  visualization?: VisualizationData;
  asciiVisualization?: string;
}

export interface UnpackedItem {
  itemId: string;
  itemIndex: number;
  name?: string;
  reason: string;
}

export interface OptimizationSummary {
  totalShipments: number;
  totalCost?: number;
  averageUtilization: number;
  itemsSuccessfullyPacked: number;
  itemsUnpacked: number;
  /** Sum of per-shipment billable weights; present when options.dimDivisor is provided. */
  totalBillableWeight?: number;
  /** Sum of per-shipment rate-card freight estimates; present when a rate card is used. */
  totalInvoiceCost?: number;
  /** Currency of totalInvoiceCost (from the rate card). */
  currency?: string;
}

export interface ResponseMetadata {
  algorithm: string;
  /** Execution time in milliseconds. */
  executionTimeMs: number;
  timestamp: string;
  requestId?: string;
  tier?: string;
  note?: string;
  warning?: string;
}

export interface OptimizationData {
  shipments: Shipment[];
  unpackedItems: UnpackedItem[];
  summary: OptimizationSummary;
  suggestions: string[];
}

/** Successful single-order response. */
export interface OptimizationResponse {
  success: true;
  data: OptimizationData;
  metadata?: ResponseMetadata;
  visualizationHtml?: string;
  shipmentVisualizations?: string[];
}

export interface OrderResult {
  orderId: string;
  success: boolean;
  data?: OptimizationData;
  error?: string;
}

export interface BatchSummary {
  totalOrders: number;
  successfulOrders: number;
  failedOrders: number;
  totalBoxesUsed: number;
  totalCost: number;
  averageUtilization: number;
  totalItemsPacked: number;
  totalItemsUnpacked: number;
  /** Sum of per-order rate-card freight estimates; present when a rate card is used. */
  totalInvoiceCost?: number;
  currency?: string;
}

/** Successful synchronous batch response. */
export interface BatchResponse {
  success: true;
  batch: true;
  results: OrderResult[];
  summary: BatchSummary;
  metadata?: ResponseMetadata;
}

/** 202 Accepted body returned for async batch submissions. */
export interface BatchJobAccepted {
  success: true;
  jobId: string;
  status: "pending";
  /** Path to poll, e.g. "/api/v1/batch-jobs/{jobId}". */
  statusUrl: string;
  totalOrders: number;
  totalItems: number;
  requestId: string;
}

export type OptimizeResponse =
  | OptimizationResponse
  | BatchResponse
  | BatchJobAccepted;

// ===== Response type guards =====

/** True when an async batch was accepted (202) and is processing in the background. */
export function isBatchJobAccepted(
  response: OptimizeResponse,
): response is BatchJobAccepted {
  return "jobId" in response;
}

/** True for synchronous batch results. */
export function isBatchResponse(
  response: OptimizeResponse,
): response is BatchResponse {
  return "batch" in response && response.batch === true;
}

/** True for single-order results. */
export function isOptimizationResponse(
  response: OptimizeResponse,
): response is OptimizationResponse {
  return !isBatchJobAccepted(response) && !isBatchResponse(response);
}

// ===== Batch job types =====

export type BatchJobStatus = "pending" | "processing" | "completed" | "failed";

/** Entry in the GET /api/v1/batch-jobs listing (statuses only). */
export interface BatchJobListItem {
  jobId: string;
  status: BatchJobStatus;
  totalItems: number;
  /** Present when the job failed. */
  error?: string;
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
  statusUrl: string;
}

/** GET /api/v1/batch-jobs response (the 20 most recent jobs). */
export interface BatchJobList {
  jobs: BatchJobListItem[];
}

/** GET /api/v1/batch-jobs/{id} response. */
export interface BatchJob {
  jobId: string;
  status: BatchJobStatus;
  totalItems: number;
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
  /** Full batch result; present when status is "completed". */
  result?: BatchResponse;
  /** Failure reason; present when status is "failed". */
  error?: string;
}

// ===== Webhook types =====

export type WebhookEvent = "batch_job.completed" | "batch_job.failed";

/**
 * JSON body CartonPilot POSTs to your webhook URL when an async batch job
 * completes or fails. Deliveries carry `X-CartonPilot-Event` and
 * `X-CartonPilot-Job-Id` headers, plus `X-CartonPilot-Signature` when the job was
 * submitted with a webhook secret.
 */
export interface WebhookPayload {
  event: WebhookEvent;
  jobId: string;
  status: BatchJobStatus;
  statusUrl: string;
  totalOrders: number;
  totalItems: number;
  /** Present on "batch_job.completed". */
  summary?: BatchSummary;
  /** Present on "batch_job.failed". */
  error?: string;
  timestamp: string;
}

// ===== Error envelope =====

export type ApiErrorCode =
  | "invalid_request"
  | "authentication_failed"
  | "endpoint_not_allowed"
  | "algorithm_not_allowed"
  | "feature_not_available"
  | "limit_exceeded"
  | "quota_exceeded"
  | "idempotency_conflict"
  | "not_found"
  | "internal_error";

export interface ApiErrorIssue {
  path: string;
  message: string;
}

/**
 * Error envelope used by every v1 endpoint:
 * `{ "error": <machine code>, "message": <human-readable>, ...details }`.
 */
export interface ApiErrorBody {
  error: ApiErrorCode | (string & {});
  message: string;
  requestId?: string;
  /** Validation problems (invalid_request only). */
  issues?: ApiErrorIssue[];
  [detail: string]: unknown;
}
