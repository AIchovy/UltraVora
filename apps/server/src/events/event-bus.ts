import type { ServerEvent } from "@ultracreator/shared";

export type EventListener = (event: ServerEvent) => void;
export type GlobalEventListener = (sessionId: string, event: ServerEvent) => void;

export class EventBus {
  private listeners = new Map<string, Set<EventListener>>();
  private globalListeners = new Set<GlobalEventListener>();

  subscribe(sessionId: string, listener: EventListener): () => void {
    let set = this.listeners.get(sessionId);
    if (!set) {
      set = new Set();
      this.listeners.set(sessionId, set);
    }
    set.add(listener);
    return () => {
      set!.delete(listener);
      if (set!.size === 0) this.listeners.delete(sessionId);
    };
  }

  /** Cross-session firehose (e.g. the media archiver watching render.done). */
  subscribeAll(listener: GlobalEventListener): () => void {
    this.globalListeners.add(listener);
    return () => {
      this.globalListeners.delete(listener);
    };
  }

  emit(sessionId: string, event: ServerEvent): void {
    const set = this.listeners.get(sessionId);
    if (set) for (const listener of [...set]) listener(event);
    for (const listener of [...this.globalListeners]) listener(sessionId, event);
  }
}
