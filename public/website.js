const toggle=document.querySelector('.menu-toggle'),nav=document.querySelector('#site-navigation');
toggle?.addEventListener('click',()=>{
  const open=toggle.getAttribute('aria-expanded')!=='true';toggle.setAttribute('aria-expanded',String(open));toggle.setAttribute('aria-label',open?'Close navigation':'Open navigation');nav.classList.toggle('open',open);
});
const groups=[...document.querySelectorAll('.nav-group')];
groups.forEach(group=>group.addEventListener('toggle',()=>{if(group.open)groups.forEach(other=>{if(other!==group)other.open=false;});}));
document.addEventListener('click',event=>{if(!event.target.closest('.nav-group'))groups.forEach(group=>group.open=false);});
document.addEventListener('keydown',event=>{
  if(event.key!=='Escape')return;
  const open=groups.find(group=>group.open);
  if(open){open.open=false;open.querySelector('summary').focus();return;}
  if(toggle?.getAttribute('aria-expanded')==='true'){toggle.click();toggle.focus();}
});
document.querySelectorAll('.preview-tabs, .customer-detail-tabs, .customer-modules').forEach(tabs=>{
  const buttons=[...tabs.querySelectorAll('[role=tab]')];
  if(tabs.classList.contains('customer-modules')){const phone=matchMedia('(max-width:700px)'), orient=()=>tabs.setAttribute('aria-orientation',phone.matches?'horizontal':'vertical');orient();phone.addEventListener('change',orient);}
  function select(button){buttons.forEach(b=>{const active=b===button;b.setAttribute('aria-selected',String(active));b.tabIndex=active?0:-1;document.getElementById(b.getAttribute('aria-controls')).hidden=!active;});}
  buttons.forEach(button=>button.addEventListener('click',()=>select(button)));
  tabs.addEventListener('keydown',event=>{
    const vertical=tabs.getAttribute('aria-orientation')==='vertical';
    if(![vertical?'ArrowUp':'ArrowLeft',vertical?'ArrowDown':'ArrowRight','Home','End'].includes(event.key))return;
    event.preventDefault();const current=buttons.indexOf(document.activeElement);
    const index=event.key==='Home'?0:event.key==='End'?buttons.length-1:(current+((event.key==='ArrowRight'||event.key==='ArrowDown')?1:-1)+buttons.length)%buttons.length;
    select(buttons[index]);buttons[index].focus();
  });
});


const docsSearch=document.querySelector('#docs-search'),docsClear=document.querySelector('#docs-search-clear'),docsResult=document.querySelector('#docs-search-result');
const docsChapters=document.querySelector('.docs-chapters'),docsPhone=matchMedia('(max-width:800px)');
if(docsChapters){docsChapters.open=!docsPhone.matches;docsPhone.addEventListener('change',()=>docsChapters.open=!docsPhone.matches);}
docsSearch?.addEventListener('input',()=>{
  const term=docsSearch.value.trim().toLowerCase(),chapters=[...document.querySelectorAll('[data-doc-chapter]')];
  chapters.forEach(link=>link.hidden=!!term&&!link.dataset.search.toLowerCase().includes(term));
  const count=chapters.filter(link=>!link.hidden).length;
  docsClear.hidden=!term;docsResult.hidden=!term;
  docsResult.textContent=count?`${count} matching chapter${count===1?'':'s'}.`:'No matching chapters. Try a module name or clear the search.';
});
docsClear?.addEventListener('click',()=>{docsSearch.value='';docsSearch.dispatchEvent(new Event('input'));docsSearch.focus();});
let copyTimer;
document.querySelectorAll('[data-copy-code]').forEach(button=>button.addEventListener('click',async()=>{
  const status=document.querySelector('.docs-copy-status');
  try{await navigator.clipboard.writeText(button.closest('.docs-code').querySelector('code').textContent);status.textContent='Example copied. Replace placeholders before use.';}
  catch{status.textContent='Copy unavailable. Select and copy the code below.';button.closest('.docs-code').querySelector('pre').focus();}
  clearTimeout(copyTimer);copyTimer=setTimeout(()=>status.textContent='',5000);
}));

const customerPreview=document.querySelector('.customer-preview');
if(customerPreview){
 const rows=[...customerPreview.querySelectorAll('[data-preview-person]')], search=customerPreview.querySelector('[data-preview-search]'), status=customerPreview.querySelector('[aria-label="Preview people status"]');
 function filterPeople(){const term=search.value.trim().toLowerCase();rows.forEach(row=>row.hidden=!(row.textContent.toLowerCase().includes(term)&&(status.value==='all'||row.dataset.status===status.value)));const count=rows.filter(row=>!row.hidden).length;customerPreview.querySelector('[data-preview-count]').textContent=count?`${count} of 4 people`:'No matching people. Clear the search or choose All people.';}
 search.addEventListener('input',filterPeople);status.addEventListener('change',filterPeople);
 for(const field of ['company','owner'])customerPreview.querySelector(`[data-preview-${field}]`).addEventListener('change',event=>customerPreview.querySelectorAll(`[data-${field}]`).forEach(cell=>cell.hidden=!event.target.checked));
 rows.forEach(row=>{row.querySelector('[name=preview-contact]').addEventListener('change',()=>row.querySelector('button').click());row.querySelector('button').addEventListener('click',event=>{
  const button=event.currentTarget;rows.forEach(r=>{r.classList.toggle('selected',r===row);r.querySelector('button').setAttribute('aria-pressed',String(r===row));r.querySelector('[name=preview-contact]').checked=r===row;});
  const detail=customerPreview.querySelector('.customer-detail');detail.querySelector('[data-detail-photo]').src=`/previews/${row.dataset.previewPerson}.png`;
  for(const [field,value] of Object.entries({name:button.dataset.name,email:row.dataset.previewPerson+'@example.com',company:button.dataset.companyValue,owner:button.dataset.ownerValue,status:row.dataset.status,state:row.dataset.status,task:button.dataset.task}))detail.querySelectorAll(`[data-detail-${field}]`).forEach(el=>el.textContent=value);
 });});
}

const githubStars = document.querySelector('[data-github-stars]');
if (githubStars) {
  fetch('/api/public/github-stars')
    .then(response => response.ok ? response.json() : null)
    .then(result => {
      const count = result?.count;
      if (!Number.isSafeInteger(count) || count < 0) return;
      githubStars.textContent = new Intl.NumberFormat('en', { notation: 'compact' }).format(count);
      githubStars.hidden = false;
      githubStars.parentElement.setAttribute('aria-label',
        `Star DryKraft on GitHub (${new Intl.NumberFormat('en').format(count)} ${count === 1 ? 'star' : 'stars'})`);
    })
    .catch(() => {});
}

document.querySelectorAll('[data-copy-mcp]').forEach(button=>button.addEventListener('click',async()=>{
  const source=document.getElementById(button.dataset.copyMcp);
  const status=document.querySelector('[data-mcp-copy-status]');
  try{
    await navigator.clipboard.writeText(source.textContent.trim());
    const label=button.textContent;
    button.textContent='Copied';
    status.textContent='Copied to clipboard.';
    setTimeout(()=>{button.textContent=label;status.textContent='';},1600);
  }catch{
    const range=document.createRange();
    range.selectNodeContents(source);
    window.getSelection().removeAllRanges();
    window.getSelection().addRange(range);
    status.textContent='Text selected. Copy it using your keyboard.';
  }
}));
