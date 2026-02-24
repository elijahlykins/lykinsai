type EventPayload = Record<string, unknown>;
type EventHandler = (payload: EventPayload) => void;

class UniversalEventBus {
  private handlers = new Map<string, Set<EventHandler>>();

  on(eventName: string, handler: EventHandler) {
    const key = String(eventName || "");
    if (!key) return () => {};
    if (!this.handlers.has(key)) this.handlers.set(key, new Set());
    const set = this.handlers.get(key)!;
    set.add(handler);
    return () => {
      set.delete(handler);
      if (!set.size) this.handlers.delete(key);
    };
  }

  emit(eventName: string, payload: EventPayload = {}) {
    const key = String(eventName || "");
    const list = this.handlers.get(key);
    if (!list) return;
    for (const handler of list) {
      try {
        handler(payload);
      } catch {
        // swallow to keep event bus resilient
      }
    }
  }
}

export const universalEventBus = new UniversalEventBus();

