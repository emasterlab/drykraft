import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

// Exercise the shipped event handlers without network calls or a browser dependency.
class Control {
  constructor() { this.attrs={}; this.events={}; this.hidden=false; this.textContent=''; this.dataset={}; this.classList={toggle(){}}; }
  addEventListener(name,fn) { (this.events[name] ||= []).push(fn); }
  async fire(name,event={}) { for(const fn of this.events[name]||[])await fn(event); }
  setAttribute(name,value) { this.attrs[name]=value; }
  removeAttribute(name) { delete this.attrs[name]; }
}
function player() {
  const selectors=['video','.launch-controls','.launch-play-overlay','[data-video-seek]','[data-video-status]','[data-video-mute]','[data-video-captions]','[data-video-fullscreen]','[data-video-pip]','[data-video-time]','[data-video-duration]','[data-video-speed]','[data-video-toggle]','[data-play-label]'];
  const elements=Object.fromEntries(selectors.map(s=>[s,new Control()]));
  const video=elements.video;
  Object.assign(video,{paused:true,ended:false,readyState:0,duration:42.005,currentTime:0,muted:false,textTracks:[{mode:'hidden'}],load(){this.loaded=true},async play(){if(this.rejectPlay)throw Error('blocked');this.paused=false;this.readyState=4},pause(){this.paused=true}});
  elements['.launch-controls'].querySelector=s=>elements[s];
  const strong=new Control();elements['.launch-play-overlay'].querySelector=()=>strong;
  const launch=new Control();launch.querySelector=s=>elements[s];launch.querySelectorAll=()=>[elements['[data-video-toggle]']];
  const chapters=[new Control(),new Control()];chapters[0].dataset.videoChapter='0';chapters[1].dataset.videoChapter='16';
  const chapterNav=new Control();chapterNav.hidden=true;
  const document={querySelector:s=>s==='[data-video-player]'?launch:s==='.launch-chapters'?chapterNav:null,querySelectorAll:s=>s==='[data-video-chapter]'?chapters:[],addEventListener(){},pictureInPictureEnabled:false};
  runInNewContext(readFileSync(new URL('../public/website.js',import.meta.url),'utf8'),{document,matchMedia:()=>({matches:false}),setTimeout,clearTimeout});
  return {video,elements,chapters,chapterNav};
}
test('launch player preserves seeking, playback recovery, captions and the native error fallback',async()=>{
  const {video,elements:e,chapters,chapterNav}=player();
  assert.equal(video.controls,false);assert.equal(e['.launch-controls'].hidden,false);assert.equal(chapterNav.hidden,false);
  assert.equal(e['[data-video-pip]'].hidden,true);assert.equal(e['[data-video-fullscreen]'].hidden,true);
  e['[data-video-seek]'].valueAsNumber=99;await e['[data-video-seek]'].fire('input');assert.equal(video.loaded,true);
  video.readyState=4;await video.fire('loadedmetadata');assert.equal(video.currentTime,42.005);
  await chapters[1].fire('click');assert.equal(video.currentTime,16);assert.equal(video.paused,false);
  await e['[data-video-toggle]'].fire('click');assert.equal(video.paused,true);
  await e['[data-video-captions]'].fire('click');assert.equal(video.textTracks[0].mode,'showing');
  await e['[data-video-captions]'].fire('click');assert.equal(video.textTracks[0].mode,'hidden');
  video.rejectPlay=true;await e['[data-video-toggle]'].fire('click');assert.match(e['[data-video-status]'].textContent,/Playback could not start/);
  await video.fire('error');assert.equal(video.controls,true);assert.equal(e['.launch-controls'].hidden,true);assert.equal(e['.launch-play-overlay'].hidden,true);assert.match(e['[data-video-status]'].textContent,/direct video link/);
});
