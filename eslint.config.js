import js from '@eslint/js'
const jsxUsage = { rules: { 'uses-vars': { create: context => ({ JSXIdentifier: node => context.sourceCode.markVariableAsUsed(node.name, node) }) } } }
const shared = { languageOptions: { ecmaVersion: 'latest', sourceType: 'module', globals: { console: 'readonly', process: 'readonly', URL: 'readonly', fetch: 'readonly', AbortSignal: 'readonly', AbortController: 'readonly', setTimeout: 'readonly', clearTimeout: 'readonly', document: 'readonly' } } }
export default [
  { ignores: ['dist/**', 'node_modules/**'] },
  js.configs.recommended,
  shared,
  { files: ['src/**/*.jsx'], languageOptions: { parserOptions: { ecmaFeatures: { jsx: true } } }, plugins: { jsx: jsxUsage }, rules: { 'jsx/uses-vars': 'error' } },
]
