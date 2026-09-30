// The example's Storybook config — never run by Farsight or its tests. The
// stories pass reads the `stories` globs below to know which Storybook
// collects which story file; e2e/tests/stories.pw.spec.ts serves a fake index
// at the URL farsight.config.json names.
const config = {
  stories: ['../src/**/*.stories.@(ts|tsx)'],
  framework: { name: '@storybook/react-vite', options: {} },
};

export default config;
