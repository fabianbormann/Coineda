const CracoLessPlugin = require('craco-less');

module.exports = {
  plugins: [
    {
      plugin: CracoLessPlugin,
      options: {
        lessLoaderOptions: {
          lessOptions: {
            modifyVars: {
              'primary-color': '#03A678',
              'layout-header-background': '#2F4858',
              'layout-trigger-background': '#006E7C',
              'processing-color': '#03A678',
            },
            javascriptEnabled: true,
          },
        },
      },
    },
  ],
};
