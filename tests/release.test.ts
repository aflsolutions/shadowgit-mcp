import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import * as z from 'zod/v4';

const PackageJson = z.object({ name: z.string(), version: z.string(), mcpName: z.string() });
const ServerJson = z.object({
  name: z.string(),
  version: z.string(),
  description: z.string(),
  packages: z.array(z.object({ identifier: z.string(), version: z.string() })),
});

const read = (file: string): unknown => JSON.parse(readFileSync(new URL(`../${file}`, import.meta.url), 'utf8'));

describe('release metadata', () => {
  it('keeps server.json in step with package.json', () => {
    const pkg = PackageJson.parse(read('package.json'));
    const server = ServerJson.parse(read('server.json'));
    expect(server.name).toBe(pkg.mcpName);
    expect(server.version).toBe(pkg.version);
    expect(server.packages).toEqual([expect.objectContaining({ identifier: pkg.name, version: pkg.version })]);
    expect(server.description.length).toBeLessThanOrEqual(100);
  });
});
