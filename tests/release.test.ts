import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

const read = (file: string) => JSON.parse(readFileSync(new URL(`../${file}`, import.meta.url), 'utf8'));

describe('release metadata', () => {
  it('keeps server.json in step with package.json', () => {
    const pkg = read('package.json');
    const server = read('server.json');
    expect(server.name).toBe(pkg.mcpName);
    expect(server.version).toBe(pkg.version);
    expect(server.packages).toEqual([expect.objectContaining({ identifier: pkg.name, version: pkg.version })]);
    expect(server.description.length).toBeLessThanOrEqual(100);
  });
});
