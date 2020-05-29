module.exports = {
  extends: 'peterkhayes/js',
  env: {
    node: true,
  },
  overrides: [
    {
      files: ['test/*.js'],
      env: {
        mocha: true,
      },
    },
  ],
};
