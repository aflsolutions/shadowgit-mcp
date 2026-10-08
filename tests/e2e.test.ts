import { describe, it, expect } from 'vitest';
import { INSTRUCTIONS } from '../src/server.js';
import { ERAS, connect } from './helpers/client.js';

describe.each(ERAS)('protocol $era', ({ mode }) => {
  it('serves the instructions, within 1,250 characters', async () => {
    const client = await connect(mode);
    try {
      expect(client.getInstructions()).toBe(INSTRUCTIONS);
    } finally {
      await client.close();
    }
    expect(INSTRUCTIONS.length).toBeLessThanOrEqual(1250);
  });
});
