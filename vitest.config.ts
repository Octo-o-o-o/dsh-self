import path from 'node:path'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: {
    alias: {
      '@dsh-self/product-spec/schema': path.resolve('packages/product-spec/src/schema.ts'),
      '@dsh-self/product-spec/theme': path.resolve('packages/product-spec/src/theme.ts'),
      '@dsh-self/product-spec/identity': path.resolve('packages/product-spec/src/identity.ts'),
      '@dsh-self/product-spec/catalog-contract': path.resolve('packages/product-spec/src/catalog-contract.ts'),
      '@dsh-self/product-spec': path.resolve('packages/product-spec/src/index.ts'),
      '@dsh-self/catalog': path.resolve('packages/catalog/src/index.ts'),
      '@dsh-self/adapters/bid-docx': path.resolve('packages/adapters/src/bid-docx/index.ts'),
      '@dsh-self/adapters/design-canvas': path.resolve('packages/adapters/src/design-canvas/index.ts'),
      '@dsh-self/adapters': path.resolve('packages/adapters/src/index.ts'),
    },
  },
  test: {
    environment: 'node',
    include: [
      'tests/unit/**/*.test.ts',
      'tests/contract/**/*.test.ts',
      'tests/e2e/**/*.test.ts',
    ],
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
})
