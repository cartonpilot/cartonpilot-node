import {
  ApiErrorBody,
  ApiErrorIssue,
  AsyncBatchOptimizeRequest,
  BatchJob,
  BatchJobAccepted,
  BatchJobList,
  BatchOptimizeRequest,
  BatchResponse,
  OptimizationResponse,
  OptimizeRequest,
  OptimizeResponse,
  SingleOptimizeRequest,
} from "./types";

export interface CartonPilotOptions {
  /** CartonPilot API key (sk_...). Sent as `Authorization: Bearer <apiKey>`. */
  apiKey: string;
  /** Defaults to "https://cartonpilot.com". */
  baseUrl?: string;
  /** Custom fetch implementation (testing, proxies). Defaults to global fetch. */
  fetch?: typeof fetch;
  /** Per-request timeout in milliseconds. Defaults to 30000. */
  timeoutMs?: number;
}

export interface OptimizeCallOptions {
  /**
   * Value for the `Idempotency-Key` header (max 200 chars). Retries with the
   * same key and payload replay the stored response without consuming quota;
   * reusing a key with a different payload fails with `idempotency_conflict`.
   */
  idempotencyKey?: string;
}

export interface WaitForBatchJobOptions {
  /** Delay between status polls in milliseconds. Defaults to 2000. */
  pollIntervalMs?: number;
  /** Overall wait budget in milliseconds. Defaults to 600000 (10 minutes). */
  timeoutMs?: number;
}

/**
 * Thrown for any non-2xx API response. `code` is the machine-readable error
 * code from the CartonPilot error envelope (e.g. "quota_exceeded"), and `body`
 * is the raw parsed response body with all extra detail fields.
 */
export class CartonPilotError extends Error {
  /** HTTP status code. */
  readonly status: number;
  /** Machine-readable error code from the error envelope. */
  readonly code: string;
  readonly requestId?: string;
  /** Validation problems (present for invalid_request errors). */
  readonly issues?: ApiErrorIssue[];
  /** Raw parsed response body. */
  readonly body: unknown;

  constructor(status: number, body: unknown) {
    const envelope = (
      body && typeof body === "object" ? body : {}
    ) as Partial<ApiErrorBody>;
    super(
      typeof envelope.message === "string"
        ? envelope.message
        : `CartonPilot API request failed with status ${status}`,
    );
    this.name = "CartonPilotError";
    this.status = status;
    this.code =
      typeof envelope.error === "string" ? envelope.error : "unknown_error";
    if (typeof envelope.requestId === "string") {
      this.requestId = envelope.requestId;
    }
    if (Array.isArray(envelope.issues)) {
      this.issues = envelope.issues as ApiErrorIssue[];
    }
    this.body = body;
  }
}

const DEFAULT_BASE_URL = "https://cartonpilot.com";
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_POLL_INTERVAL_MS = 2_000;
const DEFAULT_WAIT_TIMEOUT_MS = 600_000;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export class CartonPilot {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly fetchFn: typeof fetch;
  private readonly timeoutMs: number;

  constructor(options: CartonPilotOptions) {
    if (!options?.apiKey) {
      throw new Error("CartonPilot: `apiKey` is required");
    }
    this.apiKey = options.apiKey;
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    // Wrap the global so it keeps its expected `this` binding.
    this.fetchFn = options.fetch ?? ((input, init) => fetch(input, init));
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  /**
   * POST /api/v1/shipping-optimize
   *
   * - `items` requests resolve to a single-order {@link OptimizationResponse}.
   * - `orders` requests resolve to a {@link BatchResponse}.
   * - `orders` + `async: true` requests resolve to a {@link BatchJobAccepted}
   *   (HTTP 202); follow up with {@link waitForBatchJob} or a webhook.
   *
   * When the request shape isn't statically known, narrow the result with
   * `isBatchJobAccepted` / `isBatchResponse` / `isOptimizationResponse`.
   */
  optimize(
    request: SingleOptimizeRequest,
    opts?: OptimizeCallOptions,
  ): Promise<OptimizationResponse>;
  optimize(
    request: AsyncBatchOptimizeRequest,
    opts?: OptimizeCallOptions,
  ): Promise<BatchJobAccepted>;
  optimize(
    request: BatchOptimizeRequest,
    opts?: OptimizeCallOptions,
  ): Promise<BatchResponse>;
  optimize(
    request: OptimizeRequest,
    opts?: OptimizeCallOptions,
  ): Promise<OptimizeResponse>;
  optimize(
    request: OptimizeRequest,
    opts: OptimizeCallOptions = {},
  ): Promise<OptimizeResponse> {
    const headers: Record<string, string> = {};
    if (opts.idempotencyKey !== undefined) {
      headers["Idempotency-Key"] = opts.idempotencyKey;
    }
    return this.request<OptimizeResponse>(
      "POST",
      "/api/v1/shipping-optimize",
      request,
      headers,
    );
  }

  /**
   * GET /api/v1/batch-jobs/{jobId} — poll an async batch job. `result` is
   * present once `status` is "completed"; `error` when it is "failed".
   */
  getBatchJob(jobId: string): Promise<BatchJob> {
    return this.request<BatchJob>(
      "GET",
      `/api/v1/batch-jobs/${encodeURIComponent(jobId)}`,
    );
  }

  /** GET /api/v1/batch-jobs — the 20 most recent async batch jobs (statuses only). */
  listBatchJobs(): Promise<BatchJobList> {
    return this.request<BatchJobList>("GET", "/api/v1/batch-jobs");
  }

  /**
   * Poll a batch job until it reaches a terminal status ("completed" or
   * "failed") and return it. Throws an Error if the job is still running when
   * `timeoutMs` elapses. Note a returned job may still have failed — check
   * `job.status` (or `job.error`) before using `job.result`.
   */
  async waitForBatchJob(
    jobId: string,
    opts: WaitForBatchJobOptions = {},
  ): Promise<BatchJob> {
    const pollIntervalMs = opts.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    const timeoutMs = opts.timeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS;
    const deadline = Date.now() + timeoutMs;

    for (;;) {
      const job = await this.getBatchJob(jobId);
      if (job.status === "completed" || job.status === "failed") {
        return job;
      }
      if (Date.now() + pollIntervalMs > deadline) {
        throw new Error(
          `Timed out after ${timeoutMs}ms waiting for batch job '${jobId}' (last status: ${job.status})`,
        );
      }
      await sleep(pollIntervalMs);
    }
  }

  private async request<T>(
    method: "GET" | "POST",
    path: string,
    body?: unknown,
    extraHeaders: Record<string, string> = {},
  ): Promise<T> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.apiKey}`,
      Accept: "application/json",
      ...extraHeaders,
    };
    if (body !== undefined) {
      headers["Content-Type"] = "application/json";
    }

    const response = await this.fetchFn(`${this.baseUrl}${path}`, {
      method,
      headers,
      ...(body !== undefined && { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(this.timeoutMs),
    });

    const text = await response.text();
    let parsed: unknown;
    try {
      parsed = text.length > 0 ? JSON.parse(text) : undefined;
    } catch {
      parsed = text;
    }

    // response.ok covers 200-299, so 202 (async batch accepted) passes through.
    if (!response.ok) {
      throw new CartonPilotError(response.status, parsed);
    }
    return parsed as T;
  }
}
