// Bundles src/ into one self-contained mokuton.html (JS, CSS, fonts and icons inlined).
import { build } from 'esbuild';
import { readFile, writeFile } from 'node:fs/promises';

const result = await build({
  entryPoints: { app: 'src/app.js' },
  bundle: true,
  minify: true,
  format: 'iife',
  target: ['chrome120', 'firefox115', 'safari16'],
  outdir: 'dist',
  write: false,
  loader: { '.woff2': 'dataurl', '.woff': 'empty', '.ttf': 'empty' },
  legalComments: 'none',
  logLevel: 'info',
});

const js = result.outputFiles.find(f => f.path.endsWith('.js')).text.replace(/<\/script/gi, '<\\/script');
const css = result.outputFiles.find(f => f.path.endsWith('.css')).text;
const html = (await readFile('src/index.html', 'utf8'))
  .replace('<!--STYLE-->', () => `<style>${css}</style>`)
  .replace('<!--SCRIPT-->', () => `<script>${js}</script>`);
await writeFile('mokuton.html', html);
console.log('wrote mokuton.html');
