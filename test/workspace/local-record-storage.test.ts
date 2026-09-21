import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createSessionId } from '../../src/ids.js';
import { LocalRecordStorage } from '../../src/workspace/local-record-storage.js';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function root() {
  const directory = await mkdtemp(join(tmpdir(), 'record-storage-'));
  roots.push(directory);
  return directory;
}
describe('LocalRecordStorage', () => {
  it('rejects traversal keys and symlinked roots/records', async () => {
    const directory = await root();
    const outside = await root();
    const storage = new LocalRecordStorage(directory);
    const id = createSessionId();
    await expect(storage.writeAtomic('../escape', 'data')).rejects.toMatchObject({
      code: 'invalid_key',
    });
    await writeFile(join(outside, 'secret'), 'untouched');
    await symlink(join(outside, 'secret'), join(directory, `${id}.json`));
    await expect(storage.read(id)).rejects.toMatchObject({ code: 'unsafe_file' });
    await expect(storage.writeAtomic(id, 'changed')).rejects.toMatchObject({ code: 'unsafe_file' });
    expect(await readFile(join(outside, 'secret'), 'utf8')).toBe('untouched');
    await symlink(outside, join(directory, 'linked-root'));
    await expect(
      new LocalRecordStorage(join(directory, 'linked-root')).writeAtomic(id, 'data'),
    ).rejects.toMatchObject({ code: 'invalid_root' });
  });
  it('bounds reads/writes, rejects non-files, and leaves the previous record unchanged on failure', async () => {
    const directory = await root();
    const storage = new LocalRecordStorage(directory, 10);
    const id = createSessionId();
    await storage.writeAtomic(id, 'before');
    await expect(storage.writeAtomic(id, 'x'.repeat(11))).rejects.toMatchObject({
      code: 'size_limit',
    });
    expect(await storage.read(id)).toBe('before');
    await writeFile(join(directory, `${id}.json`), 'x'.repeat(11));
    await expect(storage.read(id)).rejects.toMatchObject({ code: 'size_limit' });
    const directoryId = createSessionId();
    await mkdir(join(directory, `${directoryId}.json`));
    await expect(storage.read(directoryId)).rejects.toMatchObject({ code: 'unsafe_file' });
  });
  it('atomically replaces a record and ignores leftover temporary files', async () => {
    const directory = await root();
    const storage = new LocalRecordStorage(directory);
    const id = createSessionId();
    await storage.writeAtomic(id, 'before');
    await writeFile(join(directory, '.interrupted.tmp'), 'partial');
    await storage.writeAtomic(id, 'after');
    expect(await storage.read(id)).toBe('after');
    expect(await storage.listKeys()).toEqual([id]);
    expect((await readdir(directory)).filter((name) => name.endsWith('.tmp'))).toEqual([
      '.interrupted.tmp',
    ]);
  });
});
