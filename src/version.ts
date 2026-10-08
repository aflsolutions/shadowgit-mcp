import { readFileSync } from 'node:fs';
import * as z from 'zod/v4';

// ../package.json from src/ (tests) and from dist/ (the published binary) alike.
const packageJson = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

export const VERSION = z.object({ version: z.string() }).parse(packageJson).version;
