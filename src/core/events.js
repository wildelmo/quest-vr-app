// Minimal event emitter shared through ctx.events.
export class Events {
  constructor() { this._m = new Map(); }
  on(type, fn) {
    if (!this._m.has(type)) this._m.set(type, new Set());
    this._m.get(type).add(fn);
    return () => this.off(type, fn);
  }
  once(type, fn) {
    const off = this.on(type, (e) => { off(); fn(e); });
    return off;
  }
  off(type, fn) { const s = this._m.get(type); if (s) s.delete(fn); }
  emit(type, payload = {}) {
    const s = this._m.get(type);
    if (!s) return;
    for (const fn of [...s]) {
      try { fn(payload); } catch (err) { console.error(`[events] handler for "${type}" threw`, err); }
    }
  }
}
