import { homedir } from 'node:os'
import { join } from 'node:path'

// This repo has no node_modules; tests import platform sources from a local checkout, as the sibling apps do.
const harness = process.env.AGNES_HARNESS ?? join(homedir(), 'agnes-harness')

export default {
  resolve: {
    alias: [{ find: /^(?:\.\.\/){4}packages\//, replacement: `${harness}/packages/` }],
  },
  server: { fs: { allow: [harness, '.'] } },
  test: { include: ['test/**/*.test.ts'] },
}
