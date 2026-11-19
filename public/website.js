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
const launchPlayer=document.querySelector('[data-video-player]');
if(launchPlayer){
 const video=launchPlayer.querySelector('video'), controls=launchPlayer.querySelector('.launch-controls'), overlay=launchPlayer.querySelector('.launch-play-overlay'), seek=launchPlayer.querySelector('[data-video-seek]'), status=launchPlayer.querySelector('[data-video-status]'), mute=launchPlayer.querySelector('[data-video-mute]'), captions=launchPlayer.querySelector('[data-video-captions]'), fullscreen=launchPlayer.querySelector('[data-video-fullscreen]'), pip=launchPlayer.querySelector('[data-video-pip]');
 const chapters=[...document.querySelectorAll('[data-video-chapter]')];let pendingSeek=null;
 const clock=seconds=>`${Math.floor(seconds/60)}:${String(Math.floor(seconds%60)).padStart(2,'0')}`;
 const duration=()=>Number.isFinite(video.duration)&&video.duration>0?video.duration:30.8;
 function update(){
  const playing=!video.paused&&!video.ended;overlay.hidden=playing;overlay.setAttribute('aria-label',video.ended?'Replay DryKraft launch film':video.currentTime>0?'Resume DryKraft launch film':'Play DryKraft launch film');
  controls.querySelector('[data-play-label]').textContent=playing?'Pause':'Play';controls.querySelector('[data-video-toggle]').setAttribute('aria-label',playing?'Pause video':'Play video');
  launchPlayer.classList.toggle('is-playing',playing);seek.max=String(duration());seek.value=String(video.currentTime);seek.setAttribute('aria-valuetext',`${clock(video.currentTime)} of ${clock(Math.ceil(duration()))}`);launchPlayer.querySelector('[data-video-time]').textContent=clock(video.currentTime);launchPlayer.querySelector('[data-video-duration]').textContent=clock(Math.ceil(duration()));
  chapters.forEach((button,i)=>{const active=video.currentTime>=Number(button.dataset.videoChapter)&&(i===chapters.length-1||video.currentTime<Number(chapters[i+1].dataset.videoChapter));if(active)button.setAttribute('aria-current','true');else button.removeAttribute('aria-current');});
 }
 async function playPause(){status.textContent='';try{if(video.paused||video.ended){if(video.ended)video.currentTime=0;await video.play();}else video.pause();}catch{status.textContent='Playback could not start. Try again, or open the video using the link below.';}update();}
 function position(seconds){const value=Math.max(0,Math.min(duration(),seconds));if(video.readyState===0){pendingSeek=value;video.load();}else video.currentTime=value;update();}
 for(const button of launchPlayer.querySelectorAll('[data-video-toggle]'))button.addEventListener('click',playPause);
 seek.addEventListener('input',()=>position(seek.valueAsNumber));
 video.addEventListener('loadedmetadata',()=>{if(pendingSeek!==null){video.currentTime=pendingSeek;pendingSeek=null;}update();});
 for(const name of ['play','pause','ended','timeupdate','seeked','durationchange'])video.addEventListener(name,update);
 video.addEventListener('waiting',()=>status.textContent='Loading video...');video.addEventListener('playing',()=>status.textContent='');video.addEventListener('error',()=>{status.textContent='The video could not load. Try reloading or use the direct video link below.';video.controls=true;controls.hidden=true;overlay.hidden=true;});
 mute.addEventListener('click',()=>video.muted=!video.muted);video.addEventListener('volumechange',()=>{mute.setAttribute('aria-pressed',String(video.muted));mute.setAttribute('aria-label',video.muted?'Unmute video':'Mute video');});
 captions.addEventListener('click',()=>{const track=video.textTracks[0];if(!track)return;track.mode=track.mode==='showing'?'hidden':'showing';captions.setAttribute('aria-pressed',String(track.mode==='showing'));captions.setAttribute('aria-label',track.mode==='showing'?'Hide captions':'Show captions');});
 launchPlayer.querySelector('[data-video-speed]').addEventListener('change',event=>video.playbackRate=Number(event.target.value));
 fullscreen.hidden=!(launchPlayer.requestFullscreen||video.webkitEnterFullscreen);fullscreen.addEventListener('click',async()=>{try{if(document.fullscreenElement)await document.exitFullscreen();else if(launchPlayer.requestFullscreen)await launchPlayer.requestFullscreen();else video.webkitEnterFullscreen();}catch{status.textContent='Fullscreen is unavailable in this browser.';}});
 document.addEventListener('fullscreenchange',()=>fullscreen.setAttribute('aria-label',document.fullscreenElement?'Exit fullscreen':'Enter fullscreen'));
 pip.hidden=!document.pictureInPictureEnabled||!video.requestPictureInPicture;pip.addEventListener('click',async()=>{try{if(document.pictureInPictureElement)await document.exitPictureInPicture();else{if(video.readyState===0)await video.play();await video.requestPictureInPicture();}}catch{status.textContent='Picture in picture is unavailable here. You can use fullscreen.';}});
 for(const button of chapters)button.addEventListener('click',async()=>{position(Number(button.dataset.videoChapter));if(video.paused)await playPause();});
 launchPlayer.addEventListener('keydown',event=>{if(event.target.matches('input,select,button,a'))return;if([' ','k','ArrowLeft','ArrowRight','m','f'].includes(event.key)){event.preventDefault();if(event.key===' '||event.key==='k')void playPause();else if(event.key==='m')mute.click();else if(event.key==='f'&&!fullscreen.hidden)fullscreen.click();else if(event.key==='ArrowLeft'||event.key==='ArrowRight')position(video.currentTime+(event.key==='ArrowRight'?5:-5));}});
 video.controls=false;controls.hidden=false;overlay.hidden=false;video.tabIndex=0;document.querySelector('.launch-chapters').hidden=false;update();
}
