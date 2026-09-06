import { readFileSync, openSync, closeSync, fsyncSync, writeFileSync, renameSync, chmodSync, mkdirSync, unlinkSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

export function fileTokenStore(path) {
  return {
    load() {
      try {
        const value = JSON.parse(readFileSync(path, 'utf8'));
        return typeof value.accessToken === 'string' && typeof value.refreshToken === 'string'
          ? { accessToken: value.accessToken, refreshToken: value.refreshToken } : null;
      } catch (error) {
        if (error.code && !['ENOENT'].includes(error.code)) throw new Error('Provider token store cannot be read');
        return null;
      }
    },
    save(value) {
      if (!value || typeof value.accessToken !== 'string' || typeof value.refreshToken !== 'string') throw new Error('Invalid provider tokens');
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      const temporary = `${path}.${randomUUID()}.tmp`;
      let fd;
      try {
        fd = openSync(temporary, 'wx', 0o600);
        writeFileSync(fd, JSON.stringify({ accessToken: value.accessToken, refreshToken: value.refreshToken }));
        fsyncSync(fd); closeSync(fd); fd = undefined;
        renameSync(temporary, path); chmodSync(path, 0o600);
        const dir = openSync(dirname(path), 'r');
        try { fsyncSync(dir); } finally { closeSync(dir); }
      } catch {
        if (fd !== undefined) closeSync(fd);
        try { unlinkSync(temporary); } catch { /* Rename may already have completed. */ }
        throw new Error('Provider tokens could not be persisted');
      }
    },
  };
}
