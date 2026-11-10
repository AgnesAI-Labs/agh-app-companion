import { homedir } from 'node:os'
import { join } from 'node:path'

// This repo has no node_modules; tests import platform sources from a local checkout, as the sibling apps do.
const harness = process.env.AGNES_HARNESS ?? join(homedir(), 'agnes-harness')

export default {
  resolve: {
    alias: [
      // The client module's host imports, stubbed for the registration test.
      { find: '@agnes/web-client', replacement: new URL('./test/stubs/web-client.js', import.meta.url).pathname },
      { find: '@agnes/web/presentation-renderers', replacement: new URL('./test/stubs/presentation-renderers.js', import.meta.url).pathname },
      { find: /^(?:\.\.\/){4}packages\//, replacement: `${harness}/packages/` },
      // The page test renders with the checkout's React.
      { find: /^react(-dom)?(\/.*)?$/, replacement: `${harness}/packages/web-ui/node_modules/react$1$2` },
    ],
  },
  server: { fs: { allow: [harness, '.'] } },
  test: { include: ['test/**/*.test.ts'] },
}
