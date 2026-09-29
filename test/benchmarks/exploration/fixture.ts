import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { trace } from '@opentelemetry/api';
import { LocalFileSystemCapability } from '../../../src/workspace/local-file-system.js';
import { fixturePaths } from './tasks.js';

export function contentDigest(files: readonly { path: string; content: string }[]): string {
  return createHash('sha256').update(JSON.stringify(files)).digest('hex');
}

/** Test-driver setup only. Production reads still use Workspace. */
export async function createFixture(repositoryRoot: string) {
  const files = new LocalFileSystemCapability({
    workspaceRoot: repositoryRoot,
    tracer: trace.getTracer('fixture-setup'),
    maxReadBytes: 262_144,
  });
  const snapshot: { path: string; content: string }[] = [];
  for (const path of fixturePaths) {
    const file = await files.readFile(path);
    snapshot.push({ path, content: file.content });
  }
  const root = await mkdtemp(join(tmpdir(), 'harness-exploration-'));
  try {
    const workspaceRoot = join(root, 'workspace');
    for (const file of snapshot) {
      const destination = join(workspaceRoot, file.path);
      await mkdir(dirname(destination), { recursive: true });
      await writeFile(destination, file.content);
    }
    const userSkillsDirectory = join(root, 'empty-user-skills');
    await mkdir(userSkillsDirectory);
    return {
      workspaceRoot,
      userSkillsDirectory,
      digest: contentDigest(snapshot),
      files: snapshot.map(({ path, content }) => ({
        path,
        sha256: createHash('sha256').update(content).digest('hex'),
      })),
      dispose: () => rm(root, { recursive: true, force: true }),
    };
  } catch (error) {
    await rm(root, { recursive: true, force: true });
    throw error;
  }
}
