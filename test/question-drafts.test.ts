import assert from 'node:assert/strict';
import test from 'node:test';
import { QuestionDrafts } from '../web/questions.js';

test('question drafts survive failed sends and snapshots, but clear after success or resolution', () => {
  const drafts=new QuestionDrafts();
  drafts.set('one','private draft');
  drafts.prune([{pending:{id:'one',question:{}}}]);
  assert.equal(drafts.get('one'),'private draft');
  assert.equal(drafts.begin('one'),true);
  assert.equal(drafts.begin('one'),false);
  drafts.settle('one',false);
  assert.equal(drafts.get('one'),'private draft');
  assert.equal(drafts.begin('one'),true);
  drafts.settle('one',true);
  assert.equal(drafts.get('one'),'');
  drafts.set('two','private draft');drafts.prune([]);
  assert.equal(drafts.get('two'),'');
});

test('form drafts remain through failed submissions and expire with resolution',()=>{
 const drafts=new QuestionDrafts();drafts.set('form',{field:'private value'});
 drafts.prune([{pending:{id:'form',elicitation:{mode:'form'}}}]);
 drafts.begin('form');drafts.settle('form',false);
 assert.deepEqual(drafts.get('form'),{field:'private value'});
 drafts.prune([]);assert.equal(drafts.get('form'),'');
});
