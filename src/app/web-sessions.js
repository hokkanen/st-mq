import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export const REMEMBERED_LOGIN_MS = 360 * 24 * 60 * 60 * 1000;
export const REMEMBERED_LOGIN_COOKIE = '__Host-stmq-session';
export const WEB_SESSIONS_KEY = 'web:remembered-sessions';
const LIMIT = 128;
const digestPattern = /^[a-f0-9]{64}$/;
const roles = new Set(['admin', 'family']);
const fields = (value, names) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).length === names.length && names.every(name => Object.hasOwn(value, name));
const failure = (message = 'Remembered login is unavailable. Try signing in without remembering this browser.', statusCode = 503) =>
  Object.assign(new Error(message), { statusCode });
const digest = value => createHash('sha256').update(value).digest('hex');
const binding = (password, value) => createHmac('sha256', password).update(`st-mq remembered login\0${value}`).digest('hex');
const equal = (a, b) => digestPattern.test(a ?? '') && digestPattern.test(b ?? '')
  && timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
const validRecord = value => fields(value, ['digest', 'role', 'binding', 'createdAt', 'expiresAt'])
  && digestPattern.test(value.digest) && roles.has(value.role) && digestPattern.test(value.binding)
  && Number.isSafeInteger(value.createdAt) && value.createdAt >= 0 && Number.isSafeInteger(value.expiresAt)
  && value.expiresAt - value.createdAt === REMEMBERED_LOGIN_MS;

export function rememberedCookieDigest(req) {
  if (!req.socket.encrypted) return null;
  const values = (req.headers.cookie ?? '').split(';').map(value => value.trim())
    .filter(value => value.startsWith(`${REMEMBERED_LOGIN_COOKIE}=`));
  if (values.length !== 1) return null;
  const token = values[0].slice(REMEMBERED_LOGIN_COOKIE.length + 1);
  return /^[A-Za-z0-9_-]{43}$/.test(token) ? digest(token) : null;
}

export function rememberedCookie(token, expiresAt) {
  // Never refresh this cookie during reads: the original password login owns its deadline.
  return `${REMEMBERED_LOGIN_COOKIE}=${token}; Path=/; Secure; HttpOnly; SameSite=Strict; Expires=${new Date(expiresAt).toUTCString()}`;
}
export const clearRememberedCookie = () => `${REMEMBERED_LOGIN_COOKIE}=; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=0`;

/** Authentication state uses the existing committed/replicated state journal.
 * A standby forwards to its active peer; it never grants access from a delayed
 * replica or writes its read-only database. Only token hashes enter storage. */
export function createWebSessions({ store, getAccess, writable = () => true, peer, clock = Date.now }) {
  const local = () => Boolean(store && !store.readOnly && writable());
  const password = role => role === 'admin' ? getAccess().token : getAccess().familyToken;
  const matches = record => validRecord(record) && Boolean(getAccess().token && password(record.role))
    && equal(record.binding, binding(password(record.role), record.digest));
  const valid = record => matches(record) && record.createdAt <= clock() && clock() < record.expiresAt;
  function read() {
    const state = store.getState(WEB_SESSIONS_KEY);
    if (state === null || state === undefined) return { version: 1, sessions: [] };
    if (!fields(state, ['version', 'sessions']) || state.version !== 1 || !Array.isArray(state.sessions)
      || state.sessions.length > LIMIT || !state.sessions.every(validRecord)
      || new Set(state.sessions.map(record => record.digest)).size !== state.sessions.length) throw failure();
    return state;
  }
  const find = hash => read().sessions.find(record => record.digest === hash && valid(record)) ?? null;
  async function perform(input) {
    if (!local()) throw failure();
    if (fields(input, ['action', 'digest']) && input.action === 'authenticate' && digestPattern.test(input.digest))
      return find(input.digest);
    const create = fields(input, ['action', 'digest', 'role', 'binding']) && input.action === 'create'
      && digestPattern.test(input.digest) && roles.has(input.role) && digestPattern.test(input.binding);
    const revoke = fields(input, ['action', 'digest']) && input.action === 'revoke' && digestPattern.test(input.digest);
    const revokeAll = fields(input, ['action', 'proof', 'session']) && input.action === 'revoke-all'
      && digestPattern.test(input.proof) && (input.session === null || digestPattern.test(input.session));
    if (!create && !revoke && !revokeAll) throw failure('Unsupported remembered-login request.', 400);
    return store.runWrite(() => {
      if (!local()) throw failure();
      const state = read();
      if (create && (!getAccess().token || !password(input.role)
        || !equal(input.binding, binding(password(input.role), input.digest)))) throw failure('Sign in again.', 401);
      if (revokeAll && (!getAccess().token || !equal(input.proof, binding(getAccess().token, 'revoke-all'))
        || input.session !== null && find(input.session)?.role !== 'admin')) throw failure('Sign in again.', 401);
      const sessions = state.sessions.filter(record => valid(record) && !(revoke && record.digest === input.digest) && !revokeAll);
      let record = null;
      if (create) {
        record = sessions.find(value => value.digest === input.digest);
        if (!record) {
          if (sessions.length >= LIMIT) throw failure('Too many remembered browsers. Sign out remembered browsers in settings first.', 409);
          const createdAt = clock();
          record = { digest: input.digest, role: input.role, binding: input.binding, createdAt, expiresAt: createdAt + REMEMBERED_LOGIN_MS };
          sessions.push(record);
        }
      }
      if (JSON.stringify(sessions) !== JSON.stringify(state.sessions)) store.setState(WEB_SESSIONS_KEY, { version: 1, sessions });
      return create ? record : { revoked: true };
    });
  }
  const dispatch = async input => {
    try { return local() ? await perform(input) : peer ? await peer.request(input) : Promise.reject(failure()); }
    catch (error) { if (error.statusCode) throw error; throw failure(); }
  };
  return {
    perform,
    async authenticate(hash) { return hash ? dispatch({ action: 'authenticate', digest: hash }) : null; },
    identity(hash, remote) {
      if (!hash) return null;
      try {
        const record = local() ? find(hash) : remote;
        // The active peer checked issuance time. Small clock differences must
        // not reject a freshly committed peer login as being from the future.
        return record?.digest === hash && matches(record) && clock() < record.expiresAt
          ? { role: record.role, source: 'password', remembered: true, expiresAt: record.expiresAt } : null;
      } catch { return null; }
    },
    async issue(role) {
      if (!roles.has(role) || !password(role)) throw failure('Sign in again.', 401);
      const token = randomBytes(32).toString('base64url'), hash = digest(token);
      const record = await dispatch({ action: 'create', digest: hash, role, binding: binding(password(role), hash) });
      if (record?.digest !== hash || record.role !== role || !matches(record) || clock() >= record.expiresAt) throw failure();
      return { token, expiresAt: record.expiresAt };
    },
    revoke: hash => hash ? dispatch({ action: 'revoke', digest: hash }) : Promise.resolve({ revoked: true }),
    revokeAll: (session = null) => dispatch({ action: 'revoke-all', proof: binding(getAccess().token, 'revoke-all'), session }),
    async credentialsChanged(next) {
      // Remove matching sessions durably before accepting changed credentials,
      // so changing a password back cannot resurrect a revoked login.
      if (!local() || !store.getState(WEB_SESSIONS_KEY)) return;
      await store.runWrite(() => {
        if (!local()) throw failure();
        const state = read(), current = getAccess();
        const sessions = state.sessions.filter(record => valid(record) && (record.role === 'admin' ? current.token === next.token
          : current.familyToken === next.familyToken));
        if (sessions.length !== state.sessions.length) store.setState(WEB_SESSIONS_KEY, { version: 1, sessions });
      });
    },
  };
}
