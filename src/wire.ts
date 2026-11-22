import { readFileSync, writeFileSync } from 'node:fs';
import { parseModule } from 'magicast';
import { addVitePlugin } from 'magicast/helpers';
import { depsOf, type Manifest, writeManifest } from './workspaces.ts';

export const WIRING = `import { alpo } from '@msb235/alpo/vite'; plugins: [alpo(), …]`;

/** The range a consumer takes alpo at: this alpo's own minor. */
function ownRange(): string {
  const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  return `^${version}`;
}

/**
 * Adds the plugin to a vite config, and alpo to the devDependencies beside it. False, with nothing
 * written, when the config is not one it can edit: built in a function, say.
 */
export function wireVite(file: string, m: Manifest): boolean {
  const src = readFileSync(file, 'utf8');
  let code: string;
  try {
    const mod = parseModule(src);
    addVitePlugin(mod, { from: '@msb235/alpo/vite', imported: 'alpo', constructor: 'alpo', index: 0 });
    const single = (src.match(/'/g)?.length ?? 0) >= (src.match(/"/g)?.length ?? 0);
    code = mod.generate({ format: { quote: single ? 'single' : 'double' } }).code;
  } catch {
    return false;
  }
  // magicast adds the import but no plugin to a config returned from a function, and says nothing.
  if (!/\balpo\(\)/.test(code)) return false;
  writeFileSync(file, code.endsWith('\n') ? code : `${code}\n`);

  if (!depsOf(m).some((d) => d.name === '@msb235/alpo')) {
    const dev = { ...(m.json.devDependencies as Record<string, string> | undefined), '@msb235/alpo': ownRange() };
    m.json.devDependencies = Object.fromEntries(Object.entries(dev).sort(([a], [b]) => a.localeCompare(b)));
    writeManifest(m);
  }
  return true;
}
