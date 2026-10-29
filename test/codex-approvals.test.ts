import assert from 'node:assert/strict';
import test from 'node:test';
import { CodexApprovals } from '../src/agents/codex-approvals.ts';

test('approval FIFO waits for upstream resolution and ignores stale or duplicate decisions', () => {
  const sent: unknown[] = [], visible: any[] = [];
  const q = new CodexApprovals(false, p=>visible.push(p), (id, decision)=>sent.push({id,decision}));
  q.add('wire-a', 'command', 'first'); q.add(2, 'edit', 'second');
  const first = visible.at(-1);
  assert.equal(first.summary, 'first'); assert.equal(first.pendingCount, 2);
  q.decide(true); q.decide(false);
  assert.deepEqual(sent, [{id:'wire-a',decision:'accept'}]);
  assert.equal(visible.at(-1).responding, true);
  q.resolved('unknown'); assert.equal(visible.at(-1).id, first.id);
  q.resolved('wire-a'); assert.equal(visible.at(-1).summary, 'second');
  assert.notEqual(visible.at(-1).id, first.id);
  q.decide(false); q.resolved(2); assert.equal(visible.at(-1), null);
});

test('Auto drains pending approvals once and turning it off restores prompting', () => {
  const sent: unknown[] = [], visible: any[] = [];
  const q = new CodexApprovals(false, p=>visible.push(p), (id,decision)=>sent.push({id,decision}));
  q.add(1,'command','a'); q.add(2,'edit','b'); q.setAuto(true);
  assert.deepEqual(sent,[{id:1,decision:'accept'},{id:2,decision:'accept'}]);
  q.setAuto(false);q.add(3,'command','c');q.resolved(1);q.resolved(2);
  assert.equal(visible.at(-1).summary,'c');assert.equal(sent.length,2);
  q.cancel(); assert.deepEqual(sent.at(-1),{id:3,decision:'decline'});assert.equal(visible.at(-1),null);
});

test('duplicate wire ids are not admitted and public ids do not reveal provider identifiers', () => {
  const visible:any[]=[];
  const q=new CodexApprovals(false,p=>visible.push(p),()=>{});
  q.add('private-wire-value','command','a'); q.add('private-wire-value','command','b');
  assert.equal(visible.at(-1).pendingCount,1);
  assert.ok(!JSON.stringify(visible).includes('private-wire-value'));
});
