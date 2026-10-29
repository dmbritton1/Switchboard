/** Drafts live only in memory and expire with the public question ID. */
export class QuestionDrafts {
  #values = new Map();
  #sending = new Set();
  get(id) { return this.#values.get(id) ?? ''; }
  set(id, value) { this.#values.set(id, value); }
  busy(id) { return this.#sending.has(id); }
  begin(id) {
    if (this.busy(id)) return false;
    this.#sending.add(id);
    return true;
  }
  settle(id, success) {
    this.#sending.delete(id);
    if (success) this.#values.delete(id);
  }
  prune(sessions) {
    const live = new Set(sessions.filter(s => (s.pending?.question || s.pending?.elicitation)).map(s => s.pending.id));
    for (const id of this.#values.keys()) if (!live.has(id)) this.#values.delete(id);
    for (const id of this.#sending) if (!live.has(id)) this.#sending.delete(id);
  }
}

/** Shared controls for the grid, open session header, and interrupt strip. */
export function questionControls(pending, drafts, submit) {
  const q = pending.question;
  const form = document.createElement('form');
  form.className = 'structured-question';
  form.onclick = e => e.stopPropagation();
  const legend = document.createElement('div');
  legend.className = 'question-progress';
  legend.textContent = `${q.header || 'Question'} · ${q.index} of ${q.total}${pending.responding ? ' · Waiting for Codex…' : ''}`;
  form.append(legend);
  const disabled = Boolean(pending.responding || drafts.busy(pending.id));
  const buttons = document.createElement('div');
  buttons.className = 'question-options';
  for (const option of q.options) {
    const button = document.createElement('button');
    button.type = 'button';
    button.disabled = disabled;
    button.textContent = option.label;
    if (option.description) {
      const description = document.createElement('small');
      description.className = 'opt-desc';
      description.textContent = option.description;
      button.append(description);
    }
    button.onclick = () => submit({ optionId: option.id });
    buttons.append(button);
  }
  form.append(buttons);
  if (q.allowText) {
    const label = document.createElement('label');
    label.textContent = q.options.length ? 'Or type another answer' : 'Your answer';
    const input = document.createElement('input');
    input.type = q.secret ? 'password' : 'text';
    input.autocomplete = 'off';
    input.spellcheck = !q.secret;
    input.maxLength = 8192;
    input.dataset.questionId = pending.id;
    input.value = drafts.get(pending.id);
    input.disabled = disabled;
    const send = document.createElement('button');
    send.type = 'submit';
    send.textContent = q.index < q.total ? 'Next' : 'Send answer';
    send.disabled = disabled || !input.value.trim();
    input.oninput = () => { drafts.set(pending.id, input.value); send.disabled = disabled || !input.value.trim(); };
    label.append(input);
    form.append(label, send);
    form.onsubmit = e => {
      e.preventDefault();
      if (!send.disabled) submit({ text: input.value });
    };
  } else form.onsubmit = e => e.preventDefault();
  const skip = document.createElement('button');
  skip.type = 'button';
  skip.className = 'ghost';
  skip.textContent = 'Skip questions';
  skip.disabled = disabled;
  skip.onclick = () => submit({ skip: true });
  form.append(skip);
  return form;
}

export function elicitationControls(pending, sessionId, drafts, submit) {
  const e=pending.elicitation;
  const form=document.createElement('form');
  form.className='structured-question mcp-form';
  form.onclick=event=>event.stopPropagation();
  const disabled=Boolean(pending.responding||drafts.busy(pending.id));
  const heading=document.createElement('div');heading.className='question-progress';
  heading.textContent=pending.responding?'Waiting for the tool…':e.mode==='url'?'Continue on the connected service':'Requested information';
  form.append(heading);
  const values={...(drafts.get(pending.id)||{})};
  if(e.mode==='url') {
    const destination=document.createElement('div');destination.textContent=e.destination;
    const link=document.createElement('a');link.textContent='Open page';link.className='ghost';
    if(!disabled){link.href=`/elicitation-url?session=${encodeURIComponent(sessionId)}&request=${encodeURIComponent(pending.id)}`;link.target='_blank';link.rel='noopener noreferrer';}
    else link.setAttribute('aria-disabled','true');
    form.append(destination,link);
  } else for(const field of e.fields) {
    const label=document.createElement('label');label.textContent=field.label+(field.required?' *':' (optional)');
    if(field.description){const description=document.createElement('small');description.textContent=field.description;label.append(description);}
    const selection=field.options||field.type==='boolean';
    const input=document.createElement(selection?'select':'input');
    input.dataset.questionId=pending.id;input.dataset.fieldId=field.id;
    input.disabled=disabled;input.required=field.required;input.autocomplete='off';
    if(selection){
      if(field.type==='array')input.multiple=true;
      else{const blank=document.createElement('option');blank.value='';blank.textContent='Choose…';input.append(blank);}
      const choices=field.options??[{id:'true',label:'Yes'},{id:'false',label:'No'}];
      for(const choice of choices){const option=document.createElement('option');option.value=choice.id;option.textContent=choice.label;
        option.selected=Array.isArray(values[field.id])?values[field.id].includes(choice.id):values[field.id]===choice.id;input.append(option);}
    }else{
      input.type=field.type==='number'||field.type==='integer'?'number':field.format==='email'?'email':field.format==='date'?'date':'text';
      if(input.type==='number'){input.step=field.type==='integer'?'1':'any';if(field.minimum!==undefined)input.min=field.minimum;if(field.maximum!==undefined)input.max=field.maximum;}
      else{input.maxLength=field.maxLength??8192;if(field.minLength!==undefined)input.minLength=field.minLength;}
      input.value=values[field.id]??'';
    }
    input.oninput=()=>{values[field.id]=input.multiple?[...input.selectedOptions].map(o=>o.value):input.value;drafts.set(pending.id,{...values});};
    label.append(input);form.append(label);
  }
  const accept=document.createElement('button');accept.type='submit';accept.textContent=e.mode==='url'?'I’ve completed this step':'Submit';accept.disabled=disabled;
  form.append(accept);
  form.onsubmit=event=>{
    event.preventDefault();if(disabled||!form.reportValidity())return;
    if(e.mode==='url'){submit({action:'accept'});return;}
    const result={};
    for(const field of e.fields){const value=values[field.id];
      if(value===undefined||value===''||Array.isArray(value)&&!value.length)continue;
      result[field.id]=field.type==='boolean'?value==='true':field.type==='integer'||field.type==='number'?Number(value):value;
    }
    submit({action:'accept',values:result});
  };
  for(const action of ['decline','cancel']){const button=document.createElement('button');button.type='button';button.className='ghost';button.disabled=disabled;
    button.textContent=action==='decline'?'Decline':'Cancel';button.onclick=()=>submit({action});form.append(button);}
  return form;
}
