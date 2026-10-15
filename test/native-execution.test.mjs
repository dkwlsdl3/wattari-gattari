import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { nativeExecution, NativeExecutionCollector } from '../src/native-execution.mjs';
import { ExecutionStore } from '../src/execution-store.mjs';
import { ClaudeProvider } from '../src/providers/claude.mjs';
import { executionGraph, executionTimeline, spanChanges } from '../src/web/executions.mjs';
const fixture = name => JSON.parse(fs.readFileSync(new URL(`./fixtures/native-executions/${name}.json`, import.meta.url)));
const claude = fixture('claude'), codex = fixture('codex');
const session = { id: `claude:${claude.sessionId}`, sessionId: claude.sessionId, provider:'claude', name:'waga-proof-native', cwd:'/tmp/waga-proof-native' };
function store(t) { const dir=fs.mkdtempSync(path.join(os.tmpdir(),'waga-proof-native-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));return new ExecutionStore(path.join(dir,'executions')); }

test('native Claude call and result pages correlate regardless of backfill order without inventing completion', () => {
 const calls=claude.records.filter(r=>r.type==='assistant'), results=claude.records.filter(r=>r.type==='user');
 const first=nativeExecution(session,results), all=nativeExecution(session,calls,first);
 const tools=all.filter(s=>s.attributes.tool_name);
 assert.ok(tools.some(s=>s.state==='returned'));
 assert.ok(tools.some(s=>s.state==='error'&&s.events.some(e=>e.content.output?.includes('rejected'))));
 assert.ok(tools.every(s=>s.durationMs===null));
 const repeated=nativeExecution(session,[...calls,...results],all);
 assert.equal(repeated.length,all.length);
 assert.ok(nativeExecution(session,calls).filter(s=>s.attributes.tool_name).every(s=>s.state==='unknown'));
 assert.deepEqual(nativeExecution({...session,sessionId:'foreign'},claude.records),[]);
});

test('native Codex measured items expose command output, exit status, file diff and real timestamps', () => {
 const s={...session,id:'codex:proof',provider:'codex'};
 const spans=nativeExecution(s,codex.records);
 const command=spans.find(s=>s.attributes.tool_name==='commandExecution');
 assert.equal(command.command,'printf native-fixture');assert.equal(command.state,'returned');
 assert.equal(command.events.find(e=>e.name==='output').content.output,'native-fixture');
 assert.ok(command.start);assert.ok(command.end);assert.equal(command.durationMs,0);
 assert.ok(spans.some(s=>s.file==='/tmp/waga-proof-native/fixture.txt'&&s.events.some(e=>e.content.diff?.includes('+after'))));
 const failed=nativeExecution(s,[{item:{type:'commandExecution',id:'failed',status:'completed',exitCode:2}}]);
 assert.equal(failed[0].state,'error');
});

test('collector automatically covers every discovered session, backfills, persists, and retains good data on read failures', async t => {
 const executionStore=store(t), a={...session,id:'claude:a'}, b={...session,id:'claude:b'};let fail=false, active=0,maxActive=0;
 const collector=new NativeExecutionCollector({store:executionStore,bridge:{async execution(s,{cursor}){
 active++;maxActive=Math.max(active,maxActive);await new Promise(r=>setImmediate(r));active--;
 if(fail&&s.id===a.id)throw Error('temporarily unavailable');
 return {records:cursor?claude.records.filter(r=>r.type==='assistant'):claude.records.filter(r=>r.type==='user'),nextCursor:cursor?null:'older'};
 }}});
 await Promise.all([collector.sweep([a,b]),collector.sweep([a,b])]);assert.equal(maxActive,1);
 for(const s of [a,b])assert.ok(executionStore.native(s).spans.some(s=>s.state==='returned'));
 const id=executionStore.native(a).id;fail=true;await collector.sweep([a,b]);
 assert.equal(executionStore.native(a).id,id);assert.match(executionStore.native(a).collection.error,/unavailable/);
 assert.ok(executionStore.native(b).spans.length);
 assert.equal(new ExecutionStore(executionStore.directory).native(a).id,id);
 assert.equal(fs.statSync(path.join(executionStore.directory,id+'.json')).mode&0o777,0o600);
 collector.close();await collector.sweep([a]);
});

test('linked agent records form real graph edges and their tools are collected without spawning or resuming', async t => {
 const executionStore=store(t);const root=structuredClone(claude.records.find(r=>r.type==='assistant'));
 const tool=root.message.content.find(b=>b.type==='tool_use');tool.name='Agent';
 const result={type:'user',sessionId:session.sessionId,timestamp:root.timestamp,message:{content:[{type:'tool_result',tool_use_id:tool.id,content:'agent running'}]},toolUseResult:{agentId:'proof-agent'}};
 const child=structuredClone(root);child.agentId='proof-agent';child.isSidechain=true;child.message.id='child-message';child.message.content=[{type:'tool_use',id:'child-tool',name:'Read',input:{file_path:'/tmp/waga-proof-native/child.txt'}}];
 const collector=new NativeExecutionCollector({store:executionStore,bridge:{async execution(s,{agentId}){return {records:agentId?[child]:[root,result],nextCursor:null};}}});
 await collector.sweep([session]);collector.close();
 const graph=executionGraph(executionStore.native(session).spans);
 assert.equal(graph.nodes.length,2);assert.equal(graph.edges.length,1);
 const agent=graph.nodes.find(n=>n.agentId==='proof-agent');assert.ok(agent.spans.some(s=>s.file==='/tmp/waga-proof-native/child.txt'));
});

test('Claude native reader pages actual JSONL, excludes foreign roots, reads linked subagents and rejects traversal', async t=>{
 const executionStore=store(t),home=path.dirname(executionStore.directory);const project=path.join(home,'.claude','projects',session.cwd.replace(/[^a-zA-Z0-9]/g,'-'));
 fs.mkdirSync(path.join(project,session.sessionId,'subagents'),{recursive:true});
 fs.writeFileSync(path.join(project,session.sessionId+'.jsonl'),claude.records.map(JSON.stringify).join('\n')+'\n');
 const child={...claude.records[0],isSidechain:true,agentId:'proof-child'};
 fs.writeFileSync(path.join(project,session.sessionId,'subagents','agent-proof-child.jsonl'),JSON.stringify(child)+'\n');
 const provider=new ClaudeProvider({homeDirectory:home});
 assert.ok((await provider.execution(session)).records.length);
 assert.equal((await provider.execution(session,{agentId:'proof-child'})).records[0].agentId,'proof-child');
 await assert.rejects(provider.execution(session,{agentId:'../elsewhere'}),/identity/);
});

test('native retention and content limits remain explicit and keep newest calls',t=>{
 const executionStore=store(t);const records=Array.from({length:2200},(_,i)=>({startedAtMs:i+1,item:{id:String(i),type:'commandExecution',command:'x',aggregatedOutput:'y'.repeat(5000)}}));
 const spans=nativeExecution({...session,provider:'codex'},records);assert.equal(spans.length,2000);assert.ok(spans.every(s=>s.contentLimited));
 const saved=executionStore.saveNative(session,spans,{});assert.ok(saved.collection.limited);assert.ok(saved.spans.length<2000);
 assert.ok(Buffer.byteLength(JSON.stringify(saved))<4*1024*1024);
});

test('a burst beyond the latest page is backfilled through the previous head without losing intervening calls',async t=>{
 const executionStore=store(t),s={...session,id:'codex:burst',provider:'codex'};let round=0;
 const entry=n=>({startedAtMs:n+1,item:{id:String(n),type:'commandExecution',command:'command '+n,status:'completed'}});
 const collector=new NativeExecutionCollector({store:executionStore,bridge:{async execution(s,{cursor}){
 if(cursor==='gap')return{records:[entry(1),entry(2)],nextCursor:'middle'};
 if(cursor==='middle')return{records:[entry(0)],nextCursor:null};
 return {records:[entry(round?3:0)],nextCursor:round?'gap':null};
 }}});
 await collector.sweep([s]);round=1;await collector.sweep([s]);await collector.sweep([s]);collector.close();
 assert.deepEqual(executionStore.native(s).spans.filter(s=>s.attributes.tool_name).map(s=>s.command),['command 0','command 1','command 2','command 3']);
});


test('multi-file Codex patches remain individually readable and old stored JSON still works', () => {
 const record=structuredClone(codex.records.find(row=>row.item.type==='fileChange'));
 const first=record.item.changes[0];
 record.item.changes.push({...first,path:'/tmp/waga-proof-native/second.txt',diff:'@@ -1 +1 @@\n-before\n+second'});
 const spans=nativeExecution({...session,id:'codex:proof',provider:'codex'},[record]);
 const changes=spanChanges(spans[0]);
 assert.deepEqual(changes.map(change=>change.path),[first.path,'/tmp/waga-proof-native/second.txt']);
 assert.match(changes[1].diff,/\+second/);
 const legacy={...spans[0],events:[{name:'content',content:{content:JSON.stringify(record.item.changes)}}]};
 assert.deepEqual(spanChanges(legacy),changes);
});

test('large Claude replacements keep separately bounded before and after evidence, even on rejection', () => {
 const record=structuredClone(claude.records.find(row=>row.type==='assistant'));
 record.message.content=[{type:'tool_use',id:'edit-large',name:'Edit',input:{file_path:'/tmp/waga-proof-native/edit.txt',old_string:'a'.repeat(6000),new_string:'b'.repeat(6000)}}];
 const rejection={type:'user',sessionId:session.sessionId,message:{content:[{type:'tool_result',tool_use_id:'edit-large',is_error:true,content:'rejected'}]}};
 const span=nativeExecution(session,[record,rejection]).find(row=>row.attributes.tool_name==='Edit');
 const [change]=spanChanges(span);
 assert.equal(change.before,'a'.repeat(4000));assert.equal(change.after,'b'.repeat(4000));
 assert.equal(change.requested,true);assert.equal(span.contentLimited,true);assert.equal(span.state,'error');
});

test('timeline exposes each observed call, file change and failure without turning their order into dependencies', () => {
 const spans=nativeExecution({...session,id:'codex:proof',provider:'codex'},codex.records);
 const {rows,edges}=executionTimeline(spans);
 assert.equal(rows.length,2);assert.equal(rows.filter(row=>row.changes.length).length,1);
 assert.equal(rows[0].changes[0].path,'/tmp/waga-proof-native/fixture.txt');
 assert.equal(rows[1].span.command,'printf native-fixture');assert.deepEqual(edges,[]);
});
