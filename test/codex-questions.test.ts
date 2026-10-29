import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeCodexQuestions } from '../src/agents/codex-questions.ts';
import { CodexApprovals } from '../src/agents/codex-approvals.ts';
import type { ApprovalRequest } from '../src/types.ts';

const params = () => ({ isBlocking: true, autoResolutionMs: null, questions: [
  {id:'private-q1',header:'Choice',question:'Pick private-token',isOther:true,isSecret:false,
    options:[{label:'private-token',description:'First option'},{label:'B',description:'Second'}]},
  {id:'private-q2',header:'Details',question:'Enter details',isOther:false,isSecret:true,options:null},
] });
const normalize = (value: unknown) => normalizeCodexQuestions(value, s=>s.replaceAll('private-token','[redacted]'));

test('question normalization bounds input and keeps raw labels out of public state', () => {
  const questions = normalize(params())!;
  assert.equal(questions.length,2);
  assert.equal(questions[0].public.prompt,'Pick [redacted]');
  assert.equal(questions[0].public.options[0].label,'[redacted]');
  assert.equal(questions[1].public.secret,true);
  for (const value of [null, {...params(),questions:[]}, {...params(),questions:[params().questions[0],params().questions[0]]},
    {...params(),questions:[{...params().questions[0],question:'x'.repeat(9000)}]},
    {...params(),questions:[{...params().questions[0],options:[{label:'',description:''}]}]},
    {...params(),isBlocking:'true'}]) assert.equal(normalize(value),null);
});

test('questions wait under Auto, rotate public IDs, and submit raw answers atomically', () => {
  const visible: (ApprovalRequest|null)[] = [], sent: unknown[] = [];
  const queue = new CodexApprovals(true,p=>visible.push(p),(id,result)=>sent.push({id,result}));
  queue.addQuestions('wire-private',normalize(params())!);
  const first = visible.at(-1)!;
  assert.equal(first.question?.index,1);
  assert.equal(sent.length,0);
  assert.ok(!JSON.stringify(visible).includes('private-'));
  assert.equal(queue.answer(first.id,{optionId:first.question!.options[0].id}),true);
  assert.equal(sent.length,0);
  const second=visible.at(-1)!;
  assert.equal(second.question?.index,2);
  assert.notEqual(first.id,second.id);
  assert.equal(queue.answer(first.id,{text:'stale'}),false);
  queue.setAuto(false);queue.setAuto(true);
  assert.equal(sent.length,0);
  assert.equal(queue.answer(second.id,{text:'secret-answer'}),true);
  assert.deepEqual(sent,[{id:'wire-private',result:{answers:{'private-q1':{answers:['private-token']},'private-q2':{answers:['secret-answer']}}}}]);
  assert.equal(visible.at(-1)?.responding,true);
  assert.ok(!JSON.stringify(visible).includes('secret-answer'));
  assert.equal(queue.answer(second.id,{text:'duplicate'}),false);
  queue.resolved('wire-private');assert.equal(visible.at(-1),null);
});

test('invalid answers leave questions actionable; Skip and Stop discard partial answers', () => {
  for(const stop of [false,true]) {
    const sent:unknown[]=[];let head:ApprovalRequest|null=null;
    const queue=new CodexApprovals(false,p=>head=p,(id,result)=>sent.push({id,result}));
    queue.addQuestions(1,normalize(params())!);
    const id=head!.id;
    for(const answer of [{}, {optionId:'bad'}, {text:''}, {text:'a',optionId:'b'}, {skip:false}, {text:'x'.repeat(9000)}]) {
      assert.equal(queue.answer(id,answer),false);
    }
    assert.equal(queue.answer(id,{text:'partial-private'}),true);
    if(stop) queue.cancel(); else queue.answer(head!.id,{skip:true});
    assert.deepEqual(sent,[{id:1,result:{answers:{}}}]);
  }
});

test('mixed approvals and questions keep FIFO and Auto only accepts approvals', () => {
  const sent:unknown[]=[];let head:ApprovalRequest|null=null;
  const queue=new CodexApprovals(false,p=>head=p,(id,result)=>sent.push({id,result}));
  queue.add('a','command','run');queue.addQuestions('q',normalize(params())!);queue.add('b','edit','edit');
  queue.setAuto(true);
  assert.deepEqual(sent,[{id:'a',result:'accept'},{id:'b',result:'accept'}]);
  queue.resolved('a');assert.equal(head!.tool,'question');
  queue.decide(true);assert.equal(sent.length,2);
  queue.resolved('q');queue.resolved('b');assert.equal(head,null);
});
