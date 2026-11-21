// The AI image's model check (infra/ai-image/verify-model.sh) and the pin it checks against (CPU_MODEL in lib/models.ts,
// infra/ai-image/model-manifest.json). The build runs the same script in CodeBuild; here it runs on folders laid out
// like Ollama's (models/blobs/sha256-<hex>), so it's tested without Docker or a 2.5 GB download.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { CPU_MODEL } from '../lib/models.js';

const SCRIPT = fileURLToPath(new URL('../ai-image/verify-model.sh', import.meta.url));
const RECORD = fileURLToPath(new URL('../ai-image/model-manifest.json', import.meta.url));
const sha = (b: Buffer | string) => `sha256:${createHash('sha256').update(b).digest('hex')}`;
const digestsIn = (manifest: string) => [...new Set(manifest.match(/sha256:[0-9a-f]{64}/g) ?? [])].sort();

describe('the pinned model', () => {
  it('the manifest record is the one pinned, and lists exactly the five pinned files', () => {
    const record = readFileSync(RECORD);
    expect(sha(record)).toBe(CPU_MODEL.manifest);
    expect(digestsIn(record.toString())).toEqual([...CPU_MODEL.digests].sort());
    const m = JSON.parse(record.toString()) as { layers: { mediaType: string }[] };
    expect(m.layers.map((l) => l.mediaType)).toEqual([
      'application/vnd.ollama.image.model',
      'application/vnd.ollama.image.template',
      'application/vnd.ollama.image.license',
      'application/vnd.ollama.image.params',
    ]);
  });
});

describe('verify-model.sh', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  /** A models folder like Ollama's: each file stored as blobs/sha256-<hex>, the manifest document among them. */
  const models = (files = ['config', 'weights', 'template', 'licence', 'params']) => {
    const dir = mkdtempSync(join(tmpdir(), 'aws-city-models-'));
    dirs.push(dir);
    mkdirSync(join(dir, 'blobs'));
    const put = (body: string) => {
      const d = sha(body);
      writeFileSync(join(dir, 'blobs', d.replace(':', '-')), body);
      return d;
    };
    const digests = files.map((f) => put(`${f} ${'x'.repeat(64)}`));
    const doc = JSON.stringify({ schemaVersion: 2, config: { digest: digests[0] }, layers: digests.slice(1).map((digest) => ({ digest })) });
    const manifest = put(doc);
    return { dir, digests, manifest, put, blob: (d: string) => join(dir, 'blobs', d.replace(':', '-')) };
  };
  const run = (...args: string[]) => spawnSync('sh', [SCRIPT, ...args], { encoding: 'utf8' });

  it('passes when the manifest and every file match their pins', () => {
    const m = models();
    const r = run(m.dir, m.manifest, ...m.digests);
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('model verified');
  });

  it('fails when a file was changed', () => {
    const m = models();
    writeFileSync(m.blob(m.digests[1]!), 'tampered weights');
    const r = run(m.dir, m.manifest, ...m.digests);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain('does not match its digest');
  });

  it('fails when a file is missing, or is a link', () => {
    const m = models();
    rmSync(m.blob(m.digests[2]!));
    expect(run(m.dir, m.manifest, ...m.digests).stderr).toContain('missing blob');
    const n = models();
    const elsewhere = join(n.dir, 'elsewhere');
    writeFileSync(elsewhere, readFileSync(n.blob(n.digests[2]!)));
    rmSync(n.blob(n.digests[2]!));
    symlinkSync(elsewhere, n.blob(n.digests[2]!));
    expect(run(n.dir, n.manifest, ...n.digests).status).not.toBe(0);
  });

  it('fails when the manifest lists a file more, or one fewer, than pinned', () => {
    const m = models();
    const extra = m.put('an extra layer');
    const doc = JSON.stringify({ config: { digest: m.digests[0] }, layers: [...m.digests.slice(1), extra].map((digest) => ({ digest })) });
    const more = m.put(doc);
    expect(run(m.dir, more, ...m.digests).stderr).toContain('lists other files than pinned');
    expect(run(m.dir, m.manifest, ...m.digests.slice(0, 4)).stderr).toContain('lists other files than pinned');
  });

  it('fails when the manifest itself is not the pinned one', () => {
    const m = models();
    writeFileSync(m.blob(m.manifest), JSON.stringify({ config: { digest: m.digests[0] }, layers: m.digests.slice(1).map((digest) => ({ digest })), note: 'changed' }));
    expect(run(m.dir, m.manifest, ...m.digests).stderr).toContain('does not match its digest');
  });

  it('reads the registry manifest as Ollama stores it (the real record, with spaces allowed)', () => {
    const m = models([]);
    const record = readFileSync(RECORD, 'utf8');
    writeFileSync(m.blob(CPU_MODEL.manifest), record);
    // The real files aren't here (2.5 GB), so the manifest check passes and the first file is then missing.
    const r = run(m.dir, CPU_MODEL.manifest, ...CPU_MODEL.digests);
    expect(r.stderr).toMatch(/^missing blob: sha256:/);
  });

  it('refuses to run without its arguments', () => {
    expect(run().status).toBe(2);
  });
});
