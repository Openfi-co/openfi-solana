// Generates Solana Kit clients for the three programs from their Anchor IDLs.
// Run after `anchor build`: npm run codegen
import { cpSync, readFileSync, rmSync } from 'node:fs';
import { rootNodeFromAnchor, type AnchorIdl } from '@codama/nodes-from-anchor';
import { renderVisitor } from '@codama/renderers-js';
import { createFromRoot } from 'codama';

for (const program of ['openfi_identity', 'openfi_allowance', 'openfi_router']) {
  const idl = JSON.parse(readFileSync(new URL(`../../target/idl/${program}.json`, import.meta.url), 'utf8')) as AnchorIdl;
  const codama = createFromRoot(rootNodeFromAnchor(idl));
  // Codama renders a whole package; keep only its generated sources.
  const tmp = new URL(`../.codegen/${program}`, import.meta.url).pathname;
  const out = new URL(`../src/generated/${program.replace('openfi_', '')}`, import.meta.url).pathname;
  await codama.accept(renderVisitor(tmp, { deleteFolderBeforeRendering: true, formatCode: false, importExtension: 'js' }));
  rmSync(out, { recursive: true, force: true });
  cpSync(`${tmp}/src/generated`, out, { recursive: true });
  rmSync(tmp, { recursive: true, force: true });
  console.log('generated', out);
}
