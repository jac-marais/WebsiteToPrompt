const path = require('path');
const webpack = require('webpack');
const dotenv = require('dotenv');
const CopyWebpackPlugin = require('copy-webpack-plugin');
const WebpackObfuscator = require('webpack-obfuscator');
const ZipPlugin = require('zip-webpack-plugin');

dotenv.config();

module.exports = {
  mode: 'production',
  devtool: false,

  entry: {
    background: './src/background.js',
    'content-script': './src/content-script.js',
    popup: './src/popup.js',
    dashboard: './src/dashboard.js',
  },

  output: {
    path: path.resolve(process.cwd(), 'dist'),
    filename: '[name].js',
    clean: true,
  },

  optimization: {
    minimize: true,
  },

  plugins: [
    new CopyWebpackPlugin({
      patterns: [
        { from: 'src/manifest.json', to: '.' },
        { from: 'src/**/*.html', to: '[name][ext]' },
        { from: 'src/icons', to: 'icons', noErrorOnMissing: true },
        { from: 'src/libs/turndown.js', to: 'libs' },
        { from: 'src/logo.png', to: '.' }
      ],
    }),
    
    new WebpackObfuscator(
        {
            rotateStringArray: true,
            stringArray: true,
            stringArrayThreshold: 1.0,
        }
    ),

   new ZipPlugin({
     filename: 'WebsiteToPrompt.zip',
   }),
  ],

  resolve: {
    modules: [path.resolve(__dirname, 'src'), 'node_modules']
  }
};
