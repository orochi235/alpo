// The config a consumer's tsconfig extends; alpo fills it with `paths` while something is linked.
import { writeFileSync } from 'node:fs';

writeFileSync(new URL('../dist/tsconfig.json', import.meta.url), '{}\n');
