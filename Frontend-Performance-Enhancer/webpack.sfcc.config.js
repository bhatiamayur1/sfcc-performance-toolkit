/**
 * webpack.sfcc.config.js
 * ─────────────────────────────────────────────────────────────────────────────
 * SFCC Performance Toolkit — /frontend-performance
 *
 * Production-optimised webpack configuration for SFCC SFRA storefronts.
 * Replaces or extends the default sgmf-scripts webpack config with:
 *
 *   ✓ Aggressive code-splitting (per-page bundles + shared chunk)
 *   ✓ Tree-shaking for ES modules (jQuery plugins, lodash, etc.)
 *   ✓ Terser minification with console.log stripping
 *   ✓ CSS extraction + cssnano minification
 *   ✓ Brotli + Gzip asset compression
 *   ✓ Bundle analysis (optional — set ANALYZE=true)
 *   ✓ Content-hashed filenames for long-lived browser caching
 *   ✓ Scope hoisting (ModuleConcatenation)
 *
 * Usage:
 *   # Production build
 *   npx webpack --config webpack.sfcc.config.js --env production
 *
 *   # Analyse bundle
 *   ANALYZE=true npx webpack --config webpack.sfcc.config.js --env production
 *
 *   # Development (source maps, no minification)
 *   npx webpack --config webpack.sfcc.config.js --env development --watch
 *
 * Prerequisites:
 *   npm install --save-dev webpack webpack-cli \
 *     mini-css-extract-plugin css-minimizer-webpack-plugin \
 *     terser-webpack-plugin compression-webpack-plugin \
 *     webpack-bundle-analyzer
 * ─────────────────────────────────────────────────────────────────────────────
 */

'use strict';

const path                     = require('path');
const MiniCssExtractPlugin     = require('mini-css-extract-plugin');
const CssMinimizerPlugin       = require('css-minimizer-webpack-plugin');
const TerserPlugin             = require('terser-webpack-plugin');
const CompressionPlugin        = require('compression-webpack-plugin');
const { BundleAnalyzerPlugin } = require('webpack-bundle-analyzer');
const zlib                     = require('zlib');

// ─── Cartridge root ───────────────────────────────────────────────────────────

const CARTRIDGE = 'app_custom_storefront';
const SRC       = path.resolve(__dirname, '../../cartridges', CARTRIDGE, 'cartridge/client/default');
const DIST      = path.resolve(__dirname, '../../cartridges', CARTRIDGE, 'cartridge/static/default');

// ─── Entry points (one per page type + shared utilities) ─────────────────────

const entries = {
    // Page-specific bundles — only loaded on matching pages
    'js/home'    : path.join(SRC, 'js/pages/home.js'),
    'js/plp'     : path.join(SRC, 'js/pages/plp.js'),
    'js/pdp'     : path.join(SRC, 'js/pages/pdp.js'),
    'js/cart'    : path.join(SRC, 'js/pages/cart.js'),
    'js/checkout': path.join(SRC, 'js/pages/checkout.js'),
    'js/account' : path.join(SRC, 'js/pages/account.js'),

    // CSS bundles — MiniCssExtractPlugin produces separate .css files
    'css/main': path.join(SRC, 'scss/main.scss'),
};

// ─── Factory ──────────────────────────────────────────────────────────────────

module.exports = (env = {}) => {
    const isProd    = env.production === true || process.env.NODE_ENV === 'production';
    const isAnalyze = process.env.ANALYZE === 'true';

    console.log(`\n⚡ SFCC webpack build — mode: ${isProd ? 'production' : 'development'}\n`);

    return {
        mode   : isProd ? 'production' : 'development',
        entry  : entries,
        devtool: isProd ? 'source-map' : 'eval-cheap-module-source-map',

        output: {
            path    : DIST,
            // Content hash in filename = long-lived cache + automatic cache busting
            filename: isProd ? '[name].[contenthash:8].js' : '[name].js',
            // Clean dist before each build
            clean   : true,
        },

        // ── Module rules ──────────────────────────────────────────────────────

        module: {
            rules: [
                // JavaScript — Babel transpilation for broad browser support
                {
                    test   : /\.js$/,
                    exclude: /node_modules/,
                    use    : {
                        loader : 'babel-loader',
                        options: {
                            presets: [
                                ['@babel/preset-env', {
                                    targets      : '> 1%, not dead, not ie 11',
                                    modules      : false,   // Preserve ES modules for tree-shaking
                                    useBuiltIns  : 'usage',
                                    corejs       : 3,
                                    bugfixes     : true
                                }]
                            ],
                            plugins: [
                                // Remove console.log in production
                                isProd && 'transform-remove-console'
                            ].filter(Boolean)
                        }
                    }
                },

                // SCSS / CSS — extract to separate files
                {
                    test: /\.(scss|css)$/,
                    use : [
                        MiniCssExtractPlugin.loader,
                        {
                            loader : 'css-loader',
                            options: { sourceMap: !isProd, importLoaders: 2 }
                        },
                        {
                            loader : 'postcss-loader',
                            options: {
                                sourceMap       : !isProd,
                                postcssOptions  : {
                                    plugins: [
                                        'autoprefixer',
                                        // Removes unused CSS selectors (use carefully — safelist needed)
                                        isProd && ['@fullhuman/postcss-purgecss', {
                                            content : [
                                                path.join(SRC, '../../templates/**/*.isml'),
                                                path.join(SRC, 'js/**/*.js')
                                            ],
                                            safelist: {
                                                standard: [/^lazy-/, /^skeleton-/, /^modal/, /^tooltip/],
                                                deep    : [/^data-/]
                                            }
                                        }]
                                    ].filter(Boolean)
                                }
                            }
                        },
                        {
                            loader : 'sass-loader',
                            options: { sourceMap: !isProd }
                        }
                    ]
                },

                // Images / fonts referenced in CSS
                {
                    test  : /\.(png|jpg|gif|svg|woff2?|eot|ttf|otf)$/i,
                    type  : 'asset',
                    parser: { dataUrlCondition: { maxSize: 4 * 1024 } } // Inline if < 4KB
                }
            ]
        },

        // ── Code splitting ────────────────────────────────────────────────────

        optimization: {
            minimize : isProd,
            minimizer: [
                // JS minification
                new TerserPlugin({
                    terserOptions: {
                        compress: {
                            drop_console   : isProd,
                            drop_debugger  : true,
                            pure_funcs     : isProd ? ['console.log', 'console.info'] : [],
                            passes         : 2    // Two passes for better compression
                        },
                        mangle : { safari10: true },
                        format : { comments: false }
                    },
                    extractComments: false
                }),
                // CSS minification
                new CssMinimizerPlugin({
                    minimizerOptions: {
                        preset: ['default', {
                            discardComments  : { removeAll: true },
                            normalizeUnicode : false   // Avoids Safari 6 bug
                        }]
                    }
                })
            ],

            // Split shared dependencies into a separate chunk loaded once
            splitChunks: {
                chunks              : 'all',
                maxInitialRequests  : 4,
                maxAsyncRequests    : 6,
                cacheGroups: {
                    // Vendor chunk — stable, long-cached
                    vendors: {
                        test    : /[\\/]node_modules[\\/]/,
                        name    : 'js/vendors',
                        priority: 20,
                        reuseExistingChunk: true
                    },
                    // SFCC storefront utilities shared across pages
                    storefront: {
                        test    : /cartridge\/client\/default\/js\/(util|base|components)/,
                        name    : 'js/storefront-common',
                        priority: 10,
                        minChunks: 2,   // Only extract if used by 2+ entry points
                        reuseExistingChunk: true
                    }
                }
            },

            // Scope hoisting — reduces bundle size and improves runtime perf
            concatenateModules: isProd,

            // Keep module IDs stable across builds (better long-term caching)
            moduleIds: 'deterministic',
            chunkIds : 'deterministic'
        },

        // ── Plugins ───────────────────────────────────────────────────────────

        plugins: [
            // Extract CSS to separate files
            new MiniCssExtractPlugin({
                filename     : isProd ? '[name].[contenthash:8].css' : '[name].css',
                chunkFilename: isProd ? '[id].[contenthash:8].css'   : '[id].css'
            }),

            // Brotli compression for modern CDN / server delivery
            isProd && new CompressionPlugin({
                filename  : '[path][base].br',
                algorithm : 'brotliCompress',
                test      : /\.(js|css|html|svg)$/,
                threshold : 1024,   // Only compress files > 1 KB
                minRatio  : 0.8,
                compressionOptions: {
                    params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 11 }
                }
            }),

            // Gzip fallback for older proxies / CDN configs
            isProd && new CompressionPlugin({
                filename  : '[path][base].gz',
                algorithm : 'gzip',
                test      : /\.(js|css|html|svg)$/,
                threshold : 1024,
                minRatio  : 0.8
            }),

            // Bundle analyser — run with ANALYZE=true
            isAnalyze && new BundleAnalyzerPlugin({
                analyzerMode  : 'static',
                reportFilename: path.resolve(__dirname, 'bundle-report.html'),
                openAnalyzer  : true
            })
        ].filter(Boolean),

        // ── Resolve ───────────────────────────────────────────────────────────

        resolve: {
            alias: {
                // Shorter import paths within cartridge
                '@util'      : path.join(SRC, 'js/util'),
                '@components': path.join(SRC, 'js/components'),
                '@scss'      : path.join(SRC, 'scss'),

                // Use the slim jQuery build to save ~10 KB
                'jquery'     : 'jquery/dist/jquery.slim.min.js'
            },
            extensions: ['.js', '.jsx', '.json', '.scss']
        },

        // ── Performance budget ────────────────────────────────────────────────

        performance: {
            hints             : isProd ? 'warning' : false,
            maxEntrypointSize : 200 * 1024,  // 200 KB per entry point
            maxAssetSize      : 300 * 1024   // 300 KB per asset
        },

        // ── Stats output ──────────────────────────────────────────────────────

        stats: {
            preset    : 'minimal',
            assets    : true,
            builtAt   : true,
            timings   : true,
            warnings  : true,
            errors    : true
        }
    };
};
