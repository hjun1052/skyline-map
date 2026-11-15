// The few Cloudflare Workers runtime types the relay uses (instead of a dependency on @cloudflare/workers-types).
// Checked with `npx tsc -p worker` (tsconfig.json in this folder).

interface DurableObjectId { toString(): string }
interface DurableObjectStub { fetch(req: Request): Promise<Response> }
interface DurableObjectNamespace { idFromName(name: string): DurableObjectId; get(id: DurableObjectId): DurableObjectStub }
interface Fetcher { fetch(req: Request): Promise<Response> }
interface RateLimit { limit(o: { key: string }): Promise<{ success: boolean }> }

interface DurableObjectStorage {
  get<T>(key: string): Promise<T | undefined>;
  put<T>(key: string, value: T): Promise<void>;
  deleteAll(): Promise<void>;
  setAlarm(at: number): Promise<void>;
  deleteAlarm(): Promise<void>;
}
interface DurableObjectState {
  storage: DurableObjectStorage;
  acceptWebSocket(ws: WebSocket, tags?: string[]): void;
  getWebSockets(tag?: string): WebSocket[];
  getTags(ws: WebSocket): string[];
}

declare class WebSocketPair { 0: WebSocket; 1: WebSocket }
interface WebSocket { accept(): void }
interface ResponseInit { webSocket?: WebSocket | null }

declare module 'cloudflare:workers' {
  export abstract class DurableObject<Env = unknown> {
    protected ctx: DurableObjectState;
    protected env: Env;
    constructor(ctx: DurableObjectState, env: Env);
  }
}
