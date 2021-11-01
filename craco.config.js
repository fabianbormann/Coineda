const CracoLessPlugin = require('craco-less');

module.exports = {
  plugins: [
    {
      plugin: CracoLessPlugin,
      options: {
        lessLoaderOptions: {
          lessOptions: {
            modifyVars: {
              'primary-color': '#03a678',
              'layout-header-background': '#2f4858',
              'layout-trigger-background': '#006e7c',
              'processing-color': '#03a678',
              'highlight-color': '#c36491',
              'error-color': '#c36491',
            },
            javascriptEnabled: true,
          },
        },
      },
    },
  ],
};
