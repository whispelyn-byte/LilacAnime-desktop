// Bundles the JASSUB (libass WebAssembly) ASS renderer into src/vendor/jassub so the
// renderer can load it without a bundler. Runs before `npm start` and `npm run dist`.
const fs = require('fs');
const path = require('path');
const esbuild = require('esbuild');

const root = path.resolve(__dirname, '..');
const pkg = path.join(root, 'node_modules', 'jassub', 'dist');
const out = path.join(root, 'src', 'vendor', 'jassub');

fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(path.join(out, 'worker'), { recursive: true });
fs.mkdirSync(path.join(out, 'wasm'), { recursive: true });

const common = { bundle: true, format: 'esm', platform: 'browser', target: 'chrome120', minify: true, legalComments: 'inline', logLevel: 'warning' };
esbuild.buildSync({ ...common, entryPoints: [path.join(pkg, 'jassub.js')], outfile: path.join(out, 'jassub.js') });
esbuild.buildSync({ ...common, entryPoints: [path.join(pkg, 'worker', 'worker.js')], outfile: path.join(out, 'worker', 'worker.js') });
for (const file of ['jassub-worker.wasm', 'jassub-worker-modern.wasm']) fs.copyFileSync(path.join(pkg, 'wasm', file), path.join(out, 'wasm', file));
fs.copyFileSync(path.join(pkg, 'default.woff2'), path.join(out, 'default.woff2'));
fs.copyFileSync(path.join(root, 'node_modules', 'jassub', 'LICENSE'), path.join(out, 'LICENSE'));
console.log('jassub bundled ->', path.relative(root, out));
