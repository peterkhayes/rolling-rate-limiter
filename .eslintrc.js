module.exports = {
  extends: 'peterkhayes',
  env: {
    node: true,
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
