import { after } from 'node:test';
import { Store } from '../../src/storage/store.js';

// Runtime fixtures may intercept operational state writes, while reports use
// the production SQLite schema and transactions independently of those mocks.
export function withReportDatabase(store, context) {
  const database = new Store(':memory:');
  (context ? context.after.bind(context) : after)(() => database.close());
  store.db = database.db;
  store.transaction = callback => database.transaction(callback);
  return store;
}
