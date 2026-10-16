import {
  cp,
  lstat,
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import { isPublicConfig } from '../shared/ordering-client.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const publicFiles = Object.freeze([
  'CNAME',
  'index.html',
  'styles.css',
  'Building.png',
  'Favicon.png',
  'Firehouse Coffee Co Logo.png',
  'Firehouse Coffee Logo No Background.png',
  'Menu.pdf',
  'CateringMenu.pdf',
  'EmploymentApplication.pdf',
  'menu/index.html',
  'catering-menu/index.html',
  'employment-application/index.html',
  'order/index.html',
  'order/order.mjs',
  'admin/index.html',
  'admin/admin.mjs',
  'admin/menu.mjs',
  'assets/config.js',
  'assets/api.mjs',
  'assets/ordering.css',
  'shared/ordering-client.mjs',
]);

export async function validatePublicConfig(directory) {
  const context = { window: {} };
  runInNewContext(
    await readFile(join(directory, 'assets/config.js'), 'utf8'),
    context,
    { timeout: 1000 },
  );
  const config = context.window.FIREHOUSE_CONFIG;
  if (
    !isPublicConfig(config) ||
    new URL(config.supabaseUrl).protocol !== 'https:'
  ) {
    throw new Error(
      'Pages requires an HTTPS Supabase URL and a public publishable/anon key. Never publish a service key.',
    );
  }
}

export async function buildPages(destination = join(root, '.pages-dist')) {
  const output = resolve(destination);
  const sourceWithinOutput = relative(output, root);
  if (
    !sourceWithinOutput ||
    (!isAbsolute(sourceWithinOutput) &&
      sourceWithinOutput.split(sep)[0] !== '..')
  )
    throw new Error('Invalid Pages output directory.');
  await validatePublicConfig(root);
  for (const file of publicFiles) {
    if (!(await lstat(join(root, file))).isFile())
      throw new Error(`Expected a regular public file: ${file}`);
  }
  await rm(output, { recursive: true, force: true });
  await mkdir(output, { recursive: true });
  for (const file of publicFiles) {
    await mkdir(dirname(join(output, file)), { recursive: true });
    await cp(join(root, file), join(output, file));
  }
  await writeFile(join(output, '.nojekyll'), '');
  return output;
}

export async function artifactFiles(directory, prefix = '') {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory())
      files.push(...(await artifactFiles(join(directory, entry.name), path)));
    else files.push(path);
  }
  return files.sort();
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const output = await buildPages();
  console.log(
    `Built GitHub Pages artifact with ${(await artifactFiles(output)).length} public files.`,
  );
}
