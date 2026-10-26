// Lint: correttezza prima dello stile. rules-of-hooks è un errore vero (hook
// condizionali = bug di stato); exhaustive-deps resta warning perché molti
// effect leggono lo store via getState() di proposito (annotati inline).
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';

export default tseslint.config(
  {
    ignores: [
      'out/**', 'release/**', 'node_modules/**', 'android/**', 'build/**',
      'resources/**', 'scripts/**', 'src/renderer/public/**', 'docs/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['src/**/*.{ts,tsx}', 'tests/**/*.ts', '*.ts'],
    languageOptions: { globals: { ...globals.browser, ...globals.node } },
    plugins: { 'react-hooks': reactHooks },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
      '@typescript-eslint/no-unused-vars': ['error', {
        argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none', ignoreRestSiblings: true,
      }],
      // catch {} vuoto è un idioma deliberato del progetto (best-effort con commento)
      'no-empty': ['error', { allowEmptyCatch: true }],
    },
  },
);
