import type { Logger } from "pino";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as Rpc from "effect/unstable/rpc/Rpc";
import * as RpcClient from "effect/unstable/rpc/RpcClient";
import * as RpcGroup from "effect/unstable/rpc/RpcGroup";
import * as RpcSerialization from "effect/unstable/rpc/RpcSerialization";
import * as Socket from "effect/unstable/socket/Socket";

const ORCHESTRATION_RPC = {
  searchThreads: "orchestration.searchThreads",
  subscribeShell: "orchestration.subscribeShell",
  subscribeThread: "orchestration.subscribeThread",
  serverGetConfig: "server.getConfig",
} as const;

const RpcUnknownError = Schema.Unknown;

// These are a deliberately narrow client view of T3's current WsRpcGroup.
// Method names, payload fields and stream semantics come from t3code
// packages/contracts/src/{orchestration,rpc}.ts at 7107a98. Unknown success
// payloads are validated structurally at the broker boundary, which keeps this
// package from copying T3's full private contracts/runtime.
const T3SearchThreadsRpc = Rpc.make(ORCHESTRATION_RPC.searchThreads, {
  payload: Schema.Struct({
    query: Schema.String,
    limit: Schema.optionalKey(Schema.Number),
  }),
  success: Schema.Unknown,
  error: RpcUnknownError,
});

const T3SubscribeShellRpc = Rpc.make(ORCHESTRATION_RPC.subscribeShell, {
  payload: Schema.Struct({
    afterSequence: Schema.optionalKey(Schema.Number),
    requestCompletionMarker: Schema.optionalKey(Schema.Boolean),
  }),
  success: Schema.Unknown,
  error: RpcUnknownError,
  stream: true,
});

const T3SubscribeThreadRpc = Rpc.make(ORCHESTRATION_RPC.subscribeThread, {
  payload: Schema.Struct({
    threadId: Schema.String,
    afterSequence: Schema.optionalKey(Schema.Number),
    requestCompletionMarker: Schema.optionalKey(Schema.Boolean),
    turnLimit: Schema.optionalKey(Schema.Number),
  }),
  success: Schema.Unknown,
  error: RpcUnknownError,
  stream: true,
});

const T3ServerGetConfigRpc = Rpc.make(ORCHESTRATION_RPC.serverGetConfig, {
  payload: Schema.Struct({}),
  success: Schema.Unknown,
  error: RpcUnknownError,
});

const T3RpcGroup = RpcGroup.make(
  T3SearchThreadsRpc,
  T3SubscribeShellRpc,
  T3SubscribeThreadRpc,
  T3ServerGetConfigRpc,
);
const makeT3RpcClient = RpcClient.make(T3RpcGroup);
type T3EffectRpcClient = Effect.Success<typeof makeT3RpcClient>;

export interface T3ThreadSubscriptionInput {
  threadId: string;
  afterSequence?: number;
  requestCompletionMarker?: boolean;
  turnLimit?: number;
}

export interface T3ShellSubscriptionInput {
  afterSequence?: number;
  requestCompletionMarker?: boolean;
}

export interface T3LiveClient {
  subscribeThread(input: T3ThreadSubscriptionInput, signal?: AbortSignal): AsyncIterable<unknown>;
  subscribeShell(input: T3ShellSubscriptionInput, signal?: AbortSignal): AsyncIterable<unknown>;
  searchThreads(input: { query: string; limit?: number }): Promise<unknown>;
  getServerConfig(): Promise<unknown>;
}

export interface EffectT3RpcClientOptions {
  baseUrl: string;
  bearerToken?: string;
  reconnectDelayMs?: number;
  fetchImpl?: typeof fetch;
}

/**
 * T3's own Effect RPC/WebSocket protocol, including ticket authentication and
 * sequence-resuming subscriptions. It intentionally does not implement a
 * second JSON-RPC dialect.
 */
export class EffectT3RpcClient implements T3LiveClient {
  private readonly fetchImpl: typeof fetch;
  private readonly reconnectDelayMs: number;

  constructor(
    private readonly options: EffectT3RpcClientOptions,
    private readonly logger: Logger,
  ) {
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
    this.reconnectDelayMs = options.reconnectDelayMs ?? 1_000;
  }

  async *subscribeThread(
    input: T3ThreadSubscriptionInput,
    signal?: AbortSignal,
  ): AsyncIterable<unknown> {
    let afterSequence = input.afterSequence;
    let attempt = 0;
    while (!signal?.aborted) {
      try {
        for await (const item of this.stream(
          ORCHESTRATION_RPC.subscribeThread,
          {
            threadId: input.threadId,
            ...(afterSequence !== undefined ? { afterSequence } : {}),
            requestCompletionMarker: input.requestCompletionMarker ?? true,
            ...(input.turnLimit !== undefined ? { turnLimit: input.turnLimit } : {}),
          },
          signal,
        )) {
          attempt = 0;
          const sequence = streamItemSequence(item);
          if (sequence !== undefined) afterSequence = Math.max(afterSequence ?? 0, sequence);
          yield item;
        }
        if (signal?.aborted) return;
        throw new Error("T3 thread subscription ended before cancellation");
      } catch (error) {
        if (signal?.aborted || isAbortError(error)) return;
        if (isPermanentRpcError(error)) throw error;
        attempt += 1;
        const waitMs = Math.min(15_000, this.reconnectDelayMs * Math.max(1, attempt));
        this.logger.warn(
          { err: rpcErrorForLog(error), threadId: input.threadId, afterSequence, attempt, waitMs },
          "T3 thread RPC disconnected; resuming from the last event sequence",
        );
        await abortableDelay(waitMs, signal);
      }
    }
  }

  async *subscribeShell(
    input: T3ShellSubscriptionInput,
    signal?: AbortSignal,
  ): AsyncIterable<unknown> {
    let afterSequence = input.afterSequence;
    let attempt = 0;
    while (!signal?.aborted) {
      try {
        for await (const item of this.stream(
          ORCHESTRATION_RPC.subscribeShell,
          {
            ...(afterSequence !== undefined ? { afterSequence } : {}),
            requestCompletionMarker: input.requestCompletionMarker ?? true,
          },
          signal,
        )) {
          attempt = 0;
          const sequence = streamItemSequence(item);
          if (sequence !== undefined) afterSequence = Math.max(afterSequence ?? 0, sequence);
          yield item;
        }
        if (signal?.aborted) return;
        throw new Error("T3 shell subscription ended before cancellation");
      } catch (error) {
        if (signal?.aborted || isAbortError(error)) return;
        if (isPermanentRpcError(error)) throw error;
        attempt += 1;
        const waitMs = Math.min(15_000, this.reconnectDelayMs * Math.max(1, attempt));
        this.logger.warn(
          { err: rpcErrorForLog(error), afterSequence, attempt, waitMs },
          "T3 shell RPC disconnected; resuming from the last event sequence",
        );
        await abortableDelay(waitMs, signal);
      }
    }
  }

  searchThreads(input: { query: string; limit?: number }): Promise<unknown> {
    return this.unary(ORCHESTRATION_RPC.searchThreads, {
      query: input.query,
      ...(input.limit !== undefined ? { limit: input.limit } : {}),
    });
  }

  getServerConfig(): Promise<unknown> {
    return this.unary(ORCHESTRATION_RPC.serverGetConfig, {});
  }

  private async unary(
    method: typeof ORCHESTRATION_RPC.searchThreads | typeof ORCHESTRATION_RPC.serverGetConfig,
    input: Record<string, unknown>,
  ): Promise<unknown> {
    const protocolLayer = await this.protocolLayer();
    const request = makeT3RpcClient.pipe(
      Effect.flatMap((client) =>
        method === ORCHESTRATION_RPC.searchThreads
          ? client[ORCHESTRATION_RPC.searchThreads](input as { query: string; limit?: number })
          : client[ORCHESTRATION_RPC.serverGetConfig]({}),
      ),
      Effect.provide(protocolLayer),
      Effect.scoped,
    );
    return Effect.runPromise(request);
  }

  private async *stream(
    method: typeof ORCHESTRATION_RPC.subscribeThread | typeof ORCHESTRATION_RPC.subscribeShell,
    input: Record<string, unknown>,
    signal?: AbortSignal,
  ): AsyncIterable<unknown> {
    const protocolLayer = await this.protocolLayer();
    const stream = Stream.unwrap(
      makeT3RpcClient.pipe(
        Effect.map((client) =>
          method === ORCHESTRATION_RPC.subscribeThread
            ? client[ORCHESTRATION_RPC.subscribeThread](
                input as unknown as T3ThreadSubscriptionInput,
              )
            : client[ORCHESTRATION_RPC.subscribeShell](input as T3ShellSubscriptionInput),
        ),
      ),
    ).pipe(Stream.provide(protocolLayer));
    const iterator = Stream.toAsyncIterable(stream)[Symbol.asyncIterator]();
    try {
      while (!signal?.aborted) {
        const next = await nextWithAbort(iterator, signal);
        if (next.aborted || next.result.done) return;
        yield next.result.value;
      }
    } finally {
      await iterator.return?.();
    }
  }

  private async protocolLayer() {
    const socketUrl = await resolveT3WebSocketUrl({
      baseUrl: this.options.baseUrl,
      ...(this.options.bearerToken ? { bearerToken: this.options.bearerToken } : {}),
      fetchImpl: this.fetchImpl,
    });
    const socketLayer = Socket.layerWebSocket(socketUrl, { openTimeout: "15 seconds" }).pipe(
      Layer.provide(Socket.layerWebSocketConstructorGlobal),
    );
    const protocolLayer = RpcClient.layerProtocolSocket().pipe(
      Layer.provide(socketLayer),
      Layer.provide(RpcSerialization.layerJson),
    );
    return protocolLayer;
  }
}

export async function resolveT3WebSocketUrl(input: {
  baseUrl: string;
  bearerToken?: string;
  fetchImpl?: typeof fetch;
}): Promise<string> {
  const base = new URL(input.baseUrl);
  const socket = new URL("/ws", base);
  socket.protocol = base.protocol === "https:" ? "wss:" : "ws:";
  if (!input.bearerToken) return socket.toString();

  const fetchImpl = input.fetchImpl ?? globalThis.fetch;
  const response = await fetchImpl(new URL("/api/auth/websocket-ticket", base), {
    method: "POST",
    headers: { authorization: `Bearer ${input.bearerToken}` },
  });
  if (!response.ok) {
    throw new Error(`T3 WebSocket ticket request failed (${response.status})`);
  }
  const payload = (await response.json()) as { ticket?: unknown };
  if (typeof payload.ticket !== "string" || !payload.ticket.trim()) {
    throw new Error("T3 WebSocket ticket response did not contain a ticket");
  }
  socket.searchParams.set("wsTicket", payload.ticket);
  return socket.toString();
}

function streamItemSequence(item: unknown): number | undefined {
  if (!isRecord(item)) return undefined;
  if (typeof item.sequence === "number") return item.sequence;
  if (item.kind === "event" && isRecord(item.event) && typeof item.event.sequence === "number") {
    return item.event.sequence;
  }
  if (item.kind === "snapshot" && isRecord(item.snapshot)) {
    if (isRecord(item.snapshot.page) && typeof item.snapshot.page.threadSequence === "number") {
      return item.snapshot.page.threadSequence;
    }
    if (typeof item.snapshot.snapshotSequence === "number") return item.snapshot.snapshotSequence;
  }
  return undefined;
}

function isPermanentRpcError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /EnvironmentAuthorization|missing required scope|not found|invalid.*thread/i.test(message);
}

function rpcErrorForLog(error: unknown): { name: string; message: string } {
  const name = error instanceof Error ? error.name : "Error";
  const message = error instanceof Error ? error.message : String(error);
  return {
    name,
    message: message.replace(/([?&]wsTicket=)[^&\s]+/gi, "$1[REDACTED]"),
  };
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && (error.name === "AbortError" || /interrupt|abort/i.test(error.message));
}

function abortableDelay(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    };
    const timeout = setTimeout(done, ms);
    const onAbort = () => {
      clearTimeout(timeout);
      done();
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

async function nextWithAbort<T>(
  iterator: AsyncIterator<T>,
  signal?: AbortSignal,
): Promise<{ aborted: true } | { aborted: false; result: IteratorResult<T> }> {
  if (!signal) return { aborted: false, result: await iterator.next() };
  if (signal.aborted) return { aborted: true };
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      signal.removeEventListener("abort", onAbort);
      resolve({ aborted: true });
    };
    signal.addEventListener("abort", onAbort, { once: true });
    void iterator.next().then(
      (result) => {
        signal.removeEventListener("abort", onAbort);
        resolve({ aborted: false, result });
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
