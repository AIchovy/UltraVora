// apps/web/test/helpers/fake-event-source.ts
type ListenerMap = Record<string, Set<(ev: MessageEvent) => void>>;

export class FakeEventSource {
  static instances: FakeEventSource[] = [];

  static reset(): void {
    FakeEventSource.instances.length = 0;
  }

  url: string;
  readyState: 0 | 1 | 2 = 0;
  withCredentials = false;
  onopen: ((ev: Event) => void) | null = null;
  onerror: ((ev: Event) => void) | null = null;
  onmessage: ((ev: MessageEvent) => void) | null = null;
  private listeners: ListenerMap = {};
  CONNECTING = 0 as const;
  OPEN = 1 as const;
  CLOSED = 2 as const;

  constructor(url: string, init?: { withCredentials?: boolean }) {
    this.url = url;
    this.withCredentials = init?.withCredentials ?? false;
    FakeEventSource.instances.push(this);
    // Open on next microtask, mirroring real EventSource behavior.
    queueMicrotask(() => this.markOpen());
  }

  /** Hook called by the implementation to simulate the server opening the stream. */
  markOpen(): void {
    if (this.readyState === 2) return;
    this.readyState = 1;
    this.onopen?.(new Event("open"));
  }

  /** Inject a frame parsed off the wire — test helper. */
  emit(type: string, data: string, lastEventId: string): void {
    if (this.readyState === 2) return;
    const ev = new MessageEvent(type, { data, lastEventId });
    this.listeners[type]?.forEach((cb) => cb(ev));
    if (type === "message") this.onmessage?.(ev);
  }

  fail(): void {
    this.onerror?.(new Event("error"));
  }

  addEventListener(type: string, cb: EventListenerOrEventListenerObject): void {
    const fn = typeof cb === "function" ? cb : cb.handleEvent.bind(cb);
    (this.listeners[type] ??= new Set()).add(fn as (ev: MessageEvent) => void);
  }

  removeEventListener(type: string, cb: EventListenerOrEventListenerObject): void {
    const fn = typeof cb === "function" ? cb : cb.handleEvent.bind(cb);
    this.listeners[type]?.delete(fn as (ev: MessageEvent) => void);
  }

  dispatchEvent(_: Event): boolean { return true; }

  close(): void { this.readyState = 2; }
}

export function installFakeEventSource(): void {
  // @ts-expect-error attach to global
  globalThis.EventSource = FakeEventSource;
}
