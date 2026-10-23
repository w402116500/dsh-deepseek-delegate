import { build } from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from '../src/config.mjs';

const css = fs.readFileSync(path.join(ROOT, 'src/ui/style.css'), 'utf8');
await build({
  entryPoints: [path.join(ROOT, 'src/ui/client.jsx')],
  outfile: path.join(ROOT, 'lib/client.js'),
  bundle: true, format: 'cjs', platform: 'browser', target: 'es2022', jsx: 'automatic',
  external: ['react', 'react/jsx-runtime'],
  define: { __DELEGATE_CSS__: JSON.stringify(css) },
  banner: { js: 'window.__ModuleLoader__.load({id:"dsh-deepseek-delegate",factory:(require)=>{var module={exports:{}};var exports=module.exports;' },
  footer: { js: 'return module.exports;}});' },
});
console.log('Built lib/client.js');
