import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { prepareDependencies } from '../src/workflow-dependencies.mjs';
const exec = promisify(execFile);
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'waga-proof-dependencies-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const source=path.join(root,'source'),workspace=path.join(root,'workspace');
  for(const dir of [source,workspace]) { await fs.mkdir(dir); await fs.writeFile(path.join(dir,'package.json'),JSON.stringify({type:'module',dependencies:{'proof-dep':'1.0.0'}})); }
  await exec('git',['init','-q',workspace]);await fs.writeFile(path.join(workspace,'.gitignore'),'node_modules/\n');
  return {source,workspace};
}
test('isolated checks import a separate installed dependency copy without modifying the original',async t=>{
  const f=await fixture(t),pkg=path.join(f.source,'node_modules/proof-dep');await fs.mkdir(pkg,{recursive:true});
  await fs.writeFile(path.join(pkg,'package.json'),JSON.stringify({name:'proof-dep',type:'module',exports:'./index.mjs'}));await fs.writeFile(path.join(pkg,'index.mjs'),'export default 42;');
  await prepareDependencies(f.source,f.workspace);await prepareDependencies(f.source,f.workspace);
  const result=await exec(process.execPath,['--input-type=module','-e',"import value from 'proof-dep'; if(value!==42)throw Error('wrong dependency'); console.log(value)"],{cwd:f.workspace});assert.equal(result.stdout.trim(),'42');
  await fs.writeFile(path.join(f.workspace,'node_modules/proof-dep/index.mjs'),'export default 0;');assert.equal(await fs.readFile(path.join(pkg,'index.mjs'),'utf8'),'export default 42;');
  await fs.writeFile(path.join(f.workspace,'package.json'),'{}');await assert.rejects(prepareDependencies(f.source,f.workspace),/의존성 명세/);
});
test('missing installation and external dependency links block environment preparation',async t=>{
  const f=await fixture(t);await assert.rejects(prepareDependencies(f.source,f.workspace),/설치된 node_modules/);
  await fs.mkdir(path.join(f.source,'node_modules'));await fs.symlink('/tmp',path.join(f.source,'node_modules/external'));
  await assert.rejects(prepareDependencies(f.source,f.workspace),/외부 경로/);
  await assert.rejects(fs.stat(path.join(f.workspace,'node_modules')),{code:'ENOENT'});
});
