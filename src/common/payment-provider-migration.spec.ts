import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

describe('global payment provider uniqueness migration', () => {
  it('runs the PostgreSQL migration regressions', async () => {
    // PGlite loads WASM through dynamic imports. Run in ordinary Node rather
    // than requiring experimental VM modules for every existing Jest suite.
    const { stdout } = await run(process.execPath, [
      '--test',
      '--test-reporter=tap',
      join(__dirname, '../../test/payment-provider-migration.test.cjs'),
    ]);
    expect(stdout).toContain('# pass 3');
    expect(stdout).toContain('# fail 0');
  }, 30000);
});
