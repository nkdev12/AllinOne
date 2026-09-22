module.exports = {
  parser: '@typescript-eslint/parser',
  parser: "@typescript-eslint/parser",
  parserOptions: {
    project: 'tsconfig.json',
    project: ["tsconfig.json", "test/tsconfig.e2e.json"],
    tsconfigRootDir: __dirname,
    sourceType: 'module',
    sourceType: "module",
  },
  plugins: ['@typescript-eslint/eslint-plugin'],
  plugins: ["@typescript-eslint/eslint-plugin"],
  extends: [
    'plugin:@typescript-eslint/recommended',
    'plugin:prettier/recommended',
    "plugin:@typescript-eslint/recommended",
    "plugin:prettier/recommended",
  ],
  root: true,
  env: {
    node: true,
    jest: true,
  },
  ignorePatterns: ['.eslintrc.js'],
  ignorePatterns: [".eslintrc.js"],
  rules: {
    '@typescript-eslint/interface-name-prefix': 'off',
    '@typescript-eslint/explicit-function-return-type': 'off',
    '@typescript-eslint/explicit-module-boundary-types': 'off',
    '@typescript-eslint/no-explicit-any': 'off',
    '@typescript-eslint/no-unused-vars': ['error', { 'argsIgnorePattern': '^_' }],
    "@typescript-eslint/interface-name-prefix": "off",
    "@typescript-eslint/explicit-function-return-type": "off",
    "@typescript-eslint/explicit-module-boundary-types": "off",
    "@typescript-eslint/no-explicit-any": "off",
    "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
  },
};

