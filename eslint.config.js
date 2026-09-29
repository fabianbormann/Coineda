import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';
import prettier from 'eslint-config-prettier';

export default tseslint.config(
  {
    ignores: ['build/**', 'dist/**', 'coverage/**', 'mobile/**'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.{ts,tsx,js,jsx}'],
    languageOptions: {
      globals: { ...globals.browser, ...globals.node },
    },
    plugins: { 'react-hooks': reactHooks },
    rules: {
      ...reactHooks.configs.recommended.rules,
      // The codebase is mid-migration from JS to TS; helper/ and
      // persistence/storage.js are still plain JS with implicit any.
      '@typescript-eslint/no-explicit-any': 'off',
    },
  },
  {
    // public/electron.js is CommonJS and runs in Electron's main process.
    files: ['public/electron.js'],
    languageOptions: {
      sourceType: 'commonjs',
      globals: { ...globals.node },
    },
    rules: {
      // This file is genuinely CommonJS (Electron main process entry point,
      // loaded via package.json "main"), not a TS/ESM file that happens to
      // use require() by mistake.
      '@typescript-eslint/no-require-imports': 'off',
    },
  },
  prettier,
);
