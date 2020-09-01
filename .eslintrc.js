module.exports = {
  extends: 'peterkhayes',
  env: {
    node: true,
  },
  parserOptions: {
    project: './tsconfig.json',
  },
  overrides: [
    {
      files: ['*.test.ts'],
      env: {
        jest: true,
      },
    },
  ],
};
