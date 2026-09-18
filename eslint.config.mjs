import js from '@eslint/js';
import globals from 'globals';

export default [
  { ignores: ['coverage/**', 'node_modules/**', 'data/**'] },
  js.configs.recommended,
  {
    files: ['**/*.mjs', 'public/**/*.js'],
    languageOptions: { ecmaVersion: 'latest', sourceType: 'module' },
    rules: { 'no-unused-vars': ['error', { argsIgnorePattern: '^_', caughtErrors: 'none' }] },
  },
  { files: ['**/*.mjs'], languageOptions: { globals: globals.node } },
  { files: ['public/**/*.js'], languageOptions: { globals: globals.browser } },
];
