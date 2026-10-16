import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import { sampleResources } from '../src/resource-gate.mjs';

test('rapid parallel gate reads share a CPU measurement window instead of reporting one busy tick as 100 percent', t => {
  let at=0, idle=100, user=100;
  t.mock.method(Date,'now',()=>at);
  t.mock.method(os,'cpus',()=>[{times:{idle,user,nice:0,sys:0,irq:0}}]);
  assert.equal(sampleResources().cpuPercent,null);
  at=100; user=200; assert.equal(sampleResources().cpuPercent,null);
  at=300; idle=300; const average=sampleResources().cpuPercent;
  assert.ok(Math.abs(average-100/3)<.01);
  at=301; user=201; assert.equal(sampleResources().cpuPercent,average);
});
