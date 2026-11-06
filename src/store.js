const fs = require('fs');
const path = require('path');
const { seed } = require('./seed');

// Small JSON-file store. Good enough for a single-tenant demo; every write
// is synchronous so the state on disk always matches what the UI shows.
class Store {
  constructor(file) {
    this.file = file || null;
    this.state = null;
    this.listeners = new Set();
    this.load();
  }

  load() {
    if (this.file && fs.existsSync(this.file)) {
      this.state = JSON.parse(fs.readFileSync(this.file, 'utf8'));
    } else {
      this.state = seed();
      this.save();
    }
  }

  reset() {
    this.state = seed();
    this.save();
  }

  save() {
    if (this.file) {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file, JSON.stringify(this.state, null, 2));
    }
    for (const fn of this.listeners) fn(this.state);
  }

  onChange(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  nextId(prefix) {
    this.state.seq += 1;
    return `${prefix}-${this.state.seq}`;
  }

  audit(actor, type, message, ref) {
    this.state.audit.unshift({ at: new Date().toISOString(), actor, type, message, ref: ref || null });
    if (this.state.audit.length > 300) this.state.audit.length = 300;
  }

  sku(sku) {
    return this.state.catalogue.find((c) => c.sku === sku);
  }

  supplier(id) {
    return this.state.suppliers.find((s) => s.id === id);
  }

  order(id) {
    return this.state.orders.find((o) => o.id === id);
  }
}

module.exports = { Store };
