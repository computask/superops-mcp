import { GRAPHQL_CAPTURE_BATCH_BYTES, type GraphqlCapture } from "./graphql-capture.js";

export const GRAPHQL_CAPTURE_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
export const GRAPHQL_CAPTURE_DAY_BYTES = 64 * 1024 * 1024;
export const GRAPHQL_CAPTURE_DAY_RECORDS = 2000;
const CHUNK = 16_000;
const ID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
interface Storage {
  get<T>(key: string): Promise<T | undefined>;
  put<T>(key: string, value: T): Promise<void>;
  delete(key: string): Promise<boolean>;
  list<T>(options: {prefix: string}): Promise<Map<string, T>>;
  getAlarm?(): Promise<number | null>;
  setAlarm?(time: number | Date): Promise<void>;
}
interface Metadata {
  captureId: string;
  startedAt: string;
  expiresAt: number;
  bytes: number;
  chunks: number;
  state: "writing" | "complete";
  captureComplete: boolean;
  invocationIds: string[];
}
const reply = (value: unknown, status = 200) => Response.json(value, {status, headers: {"Cache-Control": "no-store, private"}});
const metadataKey = (id: string) => `graphql-capture:meta:${id}`;
const chunkKey = (id: string, index: number) => `graphql-capture:body:${id}:${index}`;

/** Separate daily objects in the existing namespace; never operation records or routine logs. */
export class GraphqlCaptureStore {
  private queue: Promise<unknown> = Promise.resolve();
  constructor(private readonly storage: Storage) {}
  private serialized<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.queue.then(fn, fn);
    this.queue = result.catch(() => undefined);
    return result;
  }
  prune(now = Date.now()): Promise<number | undefined> {
    return this.serialized(() => this.pruneUnlocked(now));
  }
  private async pruneUnlocked(now: number): Promise<number | undefined> {
    const records = await this.storage.list<Metadata>({prefix: "graphql-capture:meta:"});
    let next: number | undefined;
    for (const [key, record] of records) {
      if (!key.startsWith("graphql-capture:meta:") || !Number.isFinite(record.expiresAt)) continue;
      if (record.expiresAt <= now) {
        for (let i = 0; i < record.chunks; i++) await this.storage.delete(chunkKey(record.captureId, i));
        await this.storage.delete(key);
      } else next = Math.min(next ?? record.expiresAt, record.expiresAt);
    }
    return next;
  }
  fetch(request: Request): Promise<Response> {
    return this.serialized(() => this.handle(request));
  }
  private async handle(request: Request): Promise<Response> {
    await this.pruneUnlocked(Date.now());
    if (request.method === "POST") {
      const text = await request.text(); // Internal binding only; producer bounds and redacts before this call.
      const bytes = new TextEncoder().encode(text).byteLength;
      if (bytes > GRAPHQL_CAPTURE_BATCH_BYTES + 256 * 1024) return reply({error: "capture_record_size_limit", complete: false}, 413);
      let capture: GraphqlCapture;
      try { capture = JSON.parse(text) as GraphqlCapture; } catch { return reply({error: "invalid_json"}, 400); }
      if (!ID.test(capture.captureId ?? "") || !Array.isArray(capture.exchanges) || capture.exchanges.length > 128 ||
          !Number.isFinite(Date.parse(capture.startedAt)) || Math.abs(Date.now() - Date.parse(capture.startedAt)) > 3600_000) {
        return reply({error: "invalid_capture"}, 400);
      }
      const existing = await this.storage.get<Metadata>(metadataKey(capture.captureId));
      if (existing) return reply({captureId: capture.captureId, stored: existing.state === "complete"}, existing.state === "complete" ? 200 : 409);
      const records = new Map([...(await this.storage.list<Metadata>({prefix: "graphql-capture:meta:"}))]
        .filter(([key]) => key.startsWith("graphql-capture:meta:")));
      const used = [...records.values()].reduce((sum, entry) => sum + entry.bytes, 0);
      if (records.size >= GRAPHQL_CAPTURE_DAY_RECORDS || used + bytes > GRAPHQL_CAPTURE_DAY_BYTES) {
        return reply({error: "capture_daily_limit", complete: false}, 507);
      }
      const metadata: Metadata = {captureId: capture.captureId, startedAt: capture.startedAt,
        expiresAt: Date.parse(capture.startedAt) + GRAPHQL_CAPTURE_RETENTION_MS,
        bytes, chunks: Math.ceil(text.length / CHUNK), state: "writing", captureComplete: capture.complete,
        invocationIds: [...new Set(capture.exchanges.map(exchange => exchange.invocationId).filter((id): id is string => typeof id === "string"))],
      };
      // Reserve capacity before chunks. Interrupted writes stay visible/incomplete and expire.
      // Alarm first also covers an interruption immediately after the reservation write.
      const alarm = await this.storage.getAlarm?.();
      if (!alarm || alarm > metadata.expiresAt) await this.storage.setAlarm?.(metadata.expiresAt);
      await this.storage.put(metadataKey(capture.captureId), metadata);
      for (let i = 0; i < metadata.chunks; i++) await this.storage.put(chunkKey(capture.captureId, i), text.slice(i * CHUNK, (i + 1) * CHUNK));
      await this.storage.put(metadataKey(capture.captureId), {...metadata, state: "complete"});
      return reply({captureId: capture.captureId, stored: true, complete: capture.complete}, 201);
    }
    if (request.method !== "GET") return reply({error: "method_not_allowed"}, 405);
    const url = new URL(request.url);
    const id = url.searchParams.get("captureId");
    if (id) {
      if (!ID.test(id)) return reply({error: "invalid_capture_id"}, 400);
      const metadata = await this.storage.get<Metadata>(metadataKey(id));
      if (!metadata) return reply({error: "not_found_or_expired"}, 404);
      if (metadata.state !== "complete") return reply({metadata, complete: false, error: "incomplete_capture_write"}, 409);
      const chunks: string[] = [];
      for (let i = 0; i < metadata.chunks; i++) {
        const chunk = await this.storage.get<string>(chunkKey(id, i));
        if (typeof chunk !== "string") return reply({metadata, complete: false, error: "missing_capture_chunk"}, 409);
        chunks.push(chunk);
      }
      return new Response(chunks.join(""), {headers: {"Content-Type": "application/json", "Cache-Control": "no-store, private"}});
    }
    const offset = Number(url.searchParams.get("offset") ?? "0");
    if (!Number.isInteger(offset) || offset < 0 || offset > GRAPHQL_CAPTURE_DAY_RECORDS) return reply({error: "invalid_offset"}, 400);
    const invocationId = url.searchParams.get("invocationId");
    if (invocationId && !/^[A-Za-z0-9-]{1,100}$/.test(invocationId)) return reply({error: "invalid_invocation_id"}, 400);
    const records = [...(await this.storage.list<Metadata>({prefix: "graphql-capture:meta:"}))]
      .filter(([key]) => key.startsWith("graphql-capture:meta:")).map(([, value]) => value)
      .filter(record => !invocationId || record.invocationIds.includes(invocationId))
      .sort((a, b) => a.startedAt.localeCompare(b.startedAt) || a.captureId.localeCompare(b.captureId));
    const nextOffset = offset + 50 < records.length ? offset + 50 : null;
    return reply({records: records.slice(offset, offset + 50), totalCount: records.length, nextOffset,
      complete: nextOffset === null, scope: "stored_capture_index_only"});
  }
}
