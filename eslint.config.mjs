import eslint from '@eslint/js'
import tseslint from 'typescript-eslint'

export default tseslint.config(
  { ignores: ['node_modules/**', 'out/**', 'dist/**', 'coverage/**'] },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.ts', '**/*.tsx'],
    rules: {
      '@typescript-eslint/explicit-function-return-type': 'off',
      '@typescript-eslint/no-explicit-any': 'error'
    }
  },
  {
    // 落地页原型是浏览器脚本，不是 Node 脚本。
    files: ['website/**/*.js', 'designs/**/*.js'],
    languageOptions: {
      globals: { document: 'readonly', window: 'readonly', Element: 'readonly' }
    }
  }
)
