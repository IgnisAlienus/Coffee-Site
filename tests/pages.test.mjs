import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { artifactFiles, buildPages, publicFiles, validatePublicConfig } from '../scripts/build-pages.mjs';

test('Pages artifact includes only public files and preserves production routes', async () => {
  const root = fileURLToPath(new URL('../', import.meta.url));
  await assert.rejects(buildPages(root), /Invalid Pages output directory/);
  await assert.rejects(buildPages(dirname(root)), /Invalid Pages output directory/);
  const directory = await mkdtemp(join(tmpdir(), 'firehouse-pages-'));
  try {
    const output = await buildPages(join(directory, 'site'));
    const files = await artifactFiles(output);
    assert.deepEqual(files, [...publicFiles, '.nojekyll'].sort());
    assert.equal((await readFile(join(output, 'CNAME'), 'utf8')).trim(), 'fhcoffee.co');
    for (const path of ['index.html', 'order/index.html', 'admin/index.html', 'menu/index.html', 'catering-menu/index.html', 'employment-application/index.html']) {
      assert.match(await readFile(join(output, path), 'utf8'), /<!doctype html>/i);
    }
    assert.ok(!files.some(file => /(^|\/)(supabase|node_modules|tests|scripts|\.git|\.github)(\/|$)|\.env|\.sql$/.test(file)));
    const order = await readFile(join(output, 'order/order.mjs'), 'utf8');
    const admin = await readFile(join(output, 'admin/admin.mjs'), 'utf8');
    assert.ok(order.includes('../assets/api.mjs') && admin.includes('./menu.mjs'));
    await writeFile(join(output, 'assets/config.js'), "window.FIREHOUSE_CONFIG = {supabaseUrl:'https://project.supabase.co',supabasePublishableKey:'sb_secret_forbidden'};");
    await assert.rejects(validatePublicConfig(output), /Never publish a service key/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});