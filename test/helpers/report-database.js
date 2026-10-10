import { after } from 'node:test';
import { Store } from '../../src/storage/store.js';

// Runtime fixtures may intercept operational state writes. Mirror successful
// writes in SQLite so immutable runtime records use the production existence
// checks as well as the report schema and transactions.
export function withReportDatabase(store, context, states) {
  const database = new Store(':memory:');
  (context ? context.after.bind(context) : after)(() => database.close());
  const setState = store.setState?.bind(store) ?? (() => {});
  store.setState = (key, value) => {
    const result = setState(key, value);
    database.setState(key, value);
    return result;
  };
  const rollbackMock = callback => {
    if (states) {
      const before = new Map(states);
      database.afterRollback(() => { states.clear(); for (const [key, value] of before) states.set(key, value); });
    }
    return callback();
  };
  store.db = database.db;
  store.transaction = callback => database.transaction(() => rollbackMock(callback));
  store.runWrite = (callback, options) => database.runWrite(() => rollbackMock(callback), options);
  store.afterCommit = callback => database.afterCommit(callback);
  store.afterRollback = callback => database.afterRollback(callback);
  Object.defineProperty(store, 'transactionDepth', { get: () => database.transactionDepth });
  return store;
}
