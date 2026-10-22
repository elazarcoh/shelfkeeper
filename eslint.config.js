import js from '@eslint/js'
import reactHooks from 'eslint-plugin-react-hooks'
import tseslint from 'typescript-eslint'

const restrict = (...patterns) => ({ 'no-restricted-imports': ['error', { patterns }] })

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/drizzle/**',
      'apps/web/src/routeTree.gen.ts',
      'apps/web/src/components/ui/**',
      'e2e/test-results/**',
      'e2e/playwright-report/**',
      // local dev sources' own files (Audiobookshelf, Calibre), git-ignored
      'dev-data/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  {
    languageOptions: {
      // standalone Node scripts outside every tsconfig project
      parserOptions: { projectService: { allowDefaultProject: ['scripts/*.mjs', 'scripts/lib/*.mjs', 'e2e/fake-abs/*.mjs', 'e2e/fake-hardcover/*.mjs', 'e2e/fake-nli/*.mjs'] }, tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      '@typescript-eslint/restrict-template-expressions': ['error', { allowNumber: true }],
      '@typescript-eslint/no-confusing-void-expression': 'off',
    },
  },
  { files: ['**/*.js', '**/*.config.ts', '**/*.config.js'], ...tseslint.configs.disableTypeChecked },
  {
    files: ['scripts/**/*.mjs', 'e2e/fake-abs/**/*.mjs', 'e2e/fake-hardcover/**/*.mjs', 'e2e/fake-nli/**/*.mjs'],
    ...tseslint.configs.disableTypeChecked,
    languageOptions: { globals: { process: 'readonly', console: 'readonly', URL: 'readonly', Buffer: 'readonly', fetch: 'readonly' } },
  },
  {
    files: ['packages/domain/**'],
    rules: restrict({
      group: ['@mylib/*', 'drizzle-orm', 'drizzle-orm/*', 'postgres', 'hono', 'hono/*', '@trpc/*', 'react', 'react-*', 'node:*'],
      message: 'domain is pure: no I/O and no app packages',
    }),
  },
  {
    files: ['packages/db/**'],
    rules: restrict({
      group: ['@mylib/server', '@mylib/server/*', '@mylib/web', 'hono', 'hono/*', '@trpc/*', 'react', 'react-*'],
      message: 'db may depend only on @mylib/domain',
    }),
  },
  {
    files: ['packages/connectors/**'],
    rules: restrict({
      group: ['@mylib/db', '@mylib/db/*', '@mylib/jobs', '@mylib/server', '@mylib/server/*', '@mylib/web', 'drizzle-orm', 'drizzle-orm/*', 'postgres', 'pg-boss', 'hono', 'hono/*', '@trpc/*', 'react', 'react-*'],
      message: 'connectors depend only on @mylib/domain and talk to sources through HttpClient',
    }),
  },
  {
    files: ['packages/jobs/**'],
    rules: restrict({
      group: ['@mylib/db', '@mylib/db/*', '@mylib/connectors', '@mylib/connectors/*', '@mylib/server', '@mylib/server/*', '@mylib/web', 'drizzle-orm', 'drizzle-orm/*', 'postgres', 'hono', 'hono/*', '@trpc/*', 'react', 'react-*'],
      message: 'jobs only wraps pg-boss: it may depend on @mylib/domain types, nothing else of ours',
    }),
  },
  {
    files: ['apps/server/**'],
    rules: restrict(
      { group: ['@mylib/web', 'react', 'react-*'], message: 'server must not import web code' },
      { group: ['drizzle-orm', 'drizzle-orm/*', 'postgres'], message: 'SQL lives in @mylib/db' },
    ),
  },
  {
    files: ['apps/worker/**'],
    rules: restrict(
      { group: ['@mylib/web', '@mylib/server', '@mylib/server/*', 'react', 'react-*'], message: 'the worker does not import the API or the web app' },
      { group: ['drizzle-orm', 'drizzle-orm/*', 'postgres'], message: 'SQL lives in @mylib/db' },
    ),
  },
  {
    files: ['apps/web/**/*.{ts,tsx}'],
    plugins: { 'react-hooks': reactHooks },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'error',
      ...restrict(
        {
          group: ['@mylib/db', '@mylib/db/*', 'drizzle-orm', 'drizzle-orm/*', 'postgres', 'hono', 'hono/*'],
          message: 'web talks to the server only through tRPC',
        },
        { group: ['@mylib/server', '@mylib/server/*'], allowTypeImports: true, message: 'only type imports from the server' },
      ),
    },
  },
  // TanStack Router redirects are thrown objects by design
  { files: ['apps/web/src/routes/**'], rules: { '@typescript-eslint/only-throw-error': 'off' } },
)
