// @ts-check
import eslint from '@eslint/js';
import eslintPluginPrettierRecommended from 'eslint-plugin-prettier/recommended';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: ['eslint.config.mjs'],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  eslintPluginPrettierRecommended,
  {
    languageOptions: {
      globals: {
        ...globals.node,
        ...globals.jest,
      },
      sourceType: 'commonjs',
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-floating-promises': 'warn',
      '@typescript-eslint/no-unsafe-argument': 'warn',
      "prettier/prettier": ["error", { endOfLine: "auto" }],
    },
  },
  {
    // Arquivos de teste: as regras type-aware `no-unsafe-*` disparam em massa
    // sobre valores que são `any` por natureza e cuja inspeção é justamente o
    // objetivo do teste — `response.body` do supertest, payloads JSON crus,
    // mocks do jest. Tipá-los só para satisfazer o linter transformaria a
    // asserção em tautologia (o cast diria o que o teste deveria provar).
    //
    // A relaxação é restrita a arquivos de teste: todo código de produção
    // continua sob `recommendedTypeChecked` integral.
    files: [
      '**/*.spec.ts',
      '**/*.integration-spec.ts',
      '**/*.e2e-spec.ts',
      'src/test/**/*.ts',
    ],
    rules: {
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/no-unsafe-return': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      '@typescript-eslint/no-unsafe-function-type': 'off',
      // `unbound-method` acusa `expect(obj.method)` em asserções de mock.
      '@typescript-eslint/unbound-method': 'off',
      // Mocks assíncronos sem `await` no corpo são o padrão em jest.
      '@typescript-eslint/require-await': 'off',
    },
  },
);
