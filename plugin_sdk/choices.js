// Shared accessible selection sheet; the underlying select keeps form and test semantics.
export function installChoices(){
  const sheet=document.createElement('dialog');sheet.className='choice-sheet';sheet.setAttribute('aria-label','选择');document.body.append(sheet);let source,trigger;
  const close=()=>{sheet.close();trigger?.focus();};sheet.addEventListener('click',e=>{if(e.target===sheet)close();});sheet.addEventListener('cancel',()=>trigger?.focus());
  const entries=[];
  for(const select of document.querySelectorAll('select:not([data-player-choice])')){
    select.classList.add('native-choice');select.tabIndex=-1;select.setAttribute('aria-hidden','true');
    const button=document.createElement('button');button.type='button';button.className='choice-trigger';button.setAttribute('aria-haspopup','dialog');button.setAttribute('aria-label',select.getAttribute('aria-label')||document.querySelector(`label[for="${select.id}"]`)?.textContent||'选择');select.after(button);
    button.onclick=()=>{source=select;trigger=button;sheet.replaceChildren();const title=document.createElement('h3');title.textContent=button.getAttribute('aria-label');sheet.append(title);
      for(const option of select.options){const item=document.createElement('button');item.type='button';item.className='choice-option';item.textContent=option.textContent+(option.selected?'  ✓':'');item.setAttribute('aria-pressed',String(option.selected));item.disabled=option.disabled;item.onclick=()=>{source.value=option.value;source.dispatchEvent(new Event('change',{bubbles:true}));refresh();close();};sheet.append(item);}const cancel=document.createElement('button');cancel.className='text-button';cancel.textContent='取消';cancel.onclick=close;sheet.append(cancel);sheet.showModal();};
    entries.push([select,button]);
  }
  function refresh(){for(const [select,button]of entries){button.textContent=(select.selectedOptions[0]?.textContent||'请选择')+'  ⌄';button.disabled=select.disabled;}}
  document.addEventListener('change',refresh);document.addEventListener('click',()=>queueMicrotask(refresh));refresh();return refresh;
}
