const qs = new URLSearchParams(location.search);
const roomId = (qs.get('roomId') || '').toUpperCase();
const host = qs.get('host') === '1';

const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}`);
let clientId = null;
let isHost = host;
let playlist = [];
let current = -1;
let flags = { loopQueue:false, loopSong:false, shuffle:false };

// UI elements
const roomLabel = document.getElementById('roomLabel');
const fileInput = document.getElementById('fileInput');
const tracksEl = document.getElementById('tracks');
const emptyEl = document.getElementById('playlistEmpty');
const audio = document.getElementById('audio');
const seek = document.getElementById('seek');
const playBtn = document.getElementById('play');
const prevBtn = document.getElementById('prev');
const nextBtn = document.getElementById('next');
const vol = document.getElementById('volume');
const playIcon = document.getElementById('playIcon');
const loopQueueBtn = document.getElementById('loopQueue');
const loopSongBtn = document.getElementById('loopSong');
const shuffleBtn = document.getElementById('shuffle');
const reorderBtn = document.getElementById('reorderBtn');
const fileError = document.getElementById('fileError');

roomLabel.textContent = roomId;

// WebRTC pieces
let stream = null;
let pc = null; // listener
const peers = new Map(); // host: peerId -> pc

function $(sel){return document.querySelector(sel);} // util

function renderPlaylist(){
  tracksEl.innerHTML='';
  if(playlist.length===0){ emptyEl.classList.remove('hidden'); return; }
  emptyEl.classList.add('hidden');
  playlist.forEach((t,i)=>{
    const li=document.createElement('li');
    li.className='track';
    li.draggable=isHost && reorderBtn.classList.contains('active');
    li.dataset.index=i;
    if(i===current) li.classList.add('active');
    li.innerHTML=`<span class="title">${i+1}. ${t.title}</span><span class="meta">${t.filename}</span>${isHost?'<button class="trash" title="Remove">🗑️</button>':''}`;
    li.addEventListener('click',()=>{ if(isHost) playIndex(i); });
    if(isHost){
      li.querySelector('.trash').addEventListener('click',e=>{e.stopPropagation(); removeIndex(i);});
      if(reorderBtn.classList.contains('active')){
        li.addEventListener('dragstart',e=>{e.dataTransfer.setData('text/plain',i);});
        li.addEventListener('dragover',e=>{e.preventDefault();});
        li.addEventListener('drop',e=>{e.preventDefault(); const from=Number(e.dataTransfer.getData('text/plain')); const to=i; reorder(from,to);});
      }
    }
    tracksEl.appendChild(li);
  });
}

function sendPlaylist(){
  if(isHost) ws.send(JSON.stringify({type:'playlist:update', playlist: playlist.map(t=>({title:t.title,filename:t.filename}))}));
}

function playIndex(i){
  if(i<0||i>=playlist.length) return;
  current=i;
  audio.src=playlist[i].url;
  audio.play();
  renderPlaylist();
  if(isHost) ws.send(JSON.stringify({type:'control:track', index:i}));
  if(isHost) ws.send(JSON.stringify({type:'control:playpause', state:'play'}));
}

function removeIndex(i){
  playlist.splice(i,1);
  if(current===i){ current=-1; audio.pause(); }
  if(current>i) current--; renderPlaylist(); sendPlaylist();
}

function reorder(from,to){
  if(from===to) return; const item=playlist.splice(from,1)[0]; playlist.splice(to,0,item);
  if(current===from) current=to; else if(current>from && current<=to) current--; else if(current<from && current>=to) current++;
  renderPlaylist(); sendPlaylist();
}

function nextTrack(){
  if(flags.shuffle){
    let next; if(playlist.length<=1) next=current; else { do{ next=Math.floor(Math.random()*playlist.length); }while(next===current); }
    current=next;
  } else {
    current++; if(current>=playlist.length){ if(flags.loopQueue) current=0; else { current=-1; audio.pause(); renderPlaylist(); return; }}
  }
  playIndex(current);
}

audio.addEventListener('ended',()=>{
  if(flags.loopSong){ playIndex(current); } else { nextTrack(); }
});

audio.addEventListener('timeupdate',()=>{
  if(audio.duration) seek.value = (audio.currentTime/audio.duration)*100;
});
audio.addEventListener('play',updatePlayIcon);
audio.addEventListener('pause',updatePlayIcon);
seek.addEventListener('input',()=>{
  if(audio.duration) audio.currentTime = (seek.value/100)*audio.duration;
  if(isHost) ws.send(JSON.stringify({type:'control:seek', time: audio.currentTime}));
});

playBtn.onclick=()=>{
  if(audio.paused){ audio.play(); if(isHost) ws.send(JSON.stringify({type:'control:playpause', state:'play'})); }
  else { audio.pause(); if(isHost) ws.send(JSON.stringify({type:'control:playpause', state:'pause'})); }
};
prevBtn.onclick=()=>{ if(current>0){ playIndex(current-1); } };
nextBtn.onclick=()=>{ nextTrack(); };
vol.addEventListener('input',()=>{ audio.volume=vol.value; if(isHost) ws.send(JSON.stringify({type:'control:volume', volume:vol.value})); });

function updatePlayIcon(){
  if(audio.paused){ playIcon.innerHTML='<path d="M8 5v14l11-7z"/>'; }
  else { playIcon.innerHTML='<path d="M6 5h4v14H6zm8 0h4v14h-4z"/>'; }
}

function updateFlagButtons(){
  loopQueueBtn.classList.toggle('active', flags.loopQueue);
  loopSongBtn.classList.toggle('active', flags.loopSong);
  shuffleBtn.classList.toggle('active', flags.shuffle);
}

loopQueueBtn.onclick=()=>{ if(!isHost) return; flags.loopQueue=!flags.loopQueue; if(flags.loopQueue) flags.loopSong=false; updateFlagButtons(); ws.send(JSON.stringify({type:'control:flags', flags})); };
loopSongBtn.onclick=()=>{ if(!isHost) return; flags.loopSong=!flags.loopSong; if(flags.loopSong) flags.loopQueue=false; updateFlagButtons(); ws.send(JSON.stringify({type:'control:flags', flags})); };
shuffleBtn.onclick=()=>{ if(!isHost) return; flags.shuffle=!flags.shuffle; updateFlagButtons(); ws.send(JSON.stringify({type:'control:flags', flags})); };
reorderBtn.onclick=()=>{ if(!isHost) return; reorderBtn.classList.toggle('active'); renderPlaylist(); };

fileInput.addEventListener('change', async (e)=>{
  const files=[...e.target.files];
  for(const file of files){
    const ext=file.name.split('.').pop().toLowerCase();
    if(!['mp3','wav','m4a','ogg'].includes(ext)){ fileError.textContent=`Unsupported type: ${file.name}`; setTimeout(()=>fileError.textContent='',3000); continue; }
    const url=URL.createObjectURL(file);
    let title=file.name.replace(/^.*\\/,'');
    try{
      await new Promise((res,rej)=>{
        jsmediatags.read(file,{
          onSuccess:tag=>{ if(tag.tags.title) title=tag.tags.title; res(); },
          onError:()=>res()
        });
      });
    }catch{}
    // dedupe titles
    const base=title; let n=2;
    while(playlist.some(t=>t.title===title)){ title=`${base} (${n++})`; }
    playlist.push({title, filename:file.name, url});
  }
  renderPlaylist(); sendPlaylist();
});

ws.onmessage=async ev=>{
  const msg=JSON.parse(ev.data);
  if(msg.type==='hello'){ clientId=msg.clientId; }
  else if(msg.type==='error'){ alert(msg.message); }
  else if(msg.type==='room:created'){ isHost=true; }
  else if(msg.type==='room:joined'){ isHost=msg.host===true; if(!isHost){ fileInput.disabled=true; seek.disabled=true; playBtn.disabled=true; prevBtn.disabled=true; nextBtn.disabled=true; vol.disabled=true; } }
  else if(msg.type==='webrtc:new-peer'){ if(isHost) hostCreateSenderFor(msg.peerId); }
  else if(msg.type==='webrtc:signal'){ const {fromId,payload}=msg; if(payload.kind==='offer'){ await listenerHandleOffer(fromId,payload.sdp); } else if(payload.kind==='answer'){ const p=peers.get(fromId); if(p) await p.pc.setRemoteDescription(new RTCSessionDescription(payload.sdp)); } else if(payload.kind==='ice'){ if(isHost){ const p=peers.get(fromId); if(p) await p.pc.addIceCandidate(payload.candidate); } else { if(!pc) await ensureListenerPC(); await pc.addIceCandidate(payload.candidate); } }}
  else if(msg.type==='control:playpause'){ if(!isHost && remote.srcObject) { if(msg.state==='play') remote.play().catch(()=>{}); if(msg.state==='pause') remote.pause(); }}
  else if(msg.type==='control:seek'){ if(!isHost && remote.srcObject){ remote.pause(); setTimeout(()=>remote.play().catch(()=>{}),50); }}
  else if(msg.type==='control:volume'){ if(!isHost && remote.srcObject && !remote.dataset.userVol){ remote.volume=Number(msg.volume); }}
  else if(msg.type==='control:track'){ current=msg.index; renderPlaylist(); }
  else if(msg.type==='control:flags'){ flags=msg.flags; updateFlagButtons(); }
  else if(msg.type==='playlist:update'){ playlist=msg.playlist.map(t=>({title:t.title, filename:t.filename})); renderPlaylist(); }
  else if(msg.type==='sync:state'){ playlist=msg.state.playlist; current=msg.state.current; flags=msg.state.flags; renderPlaylist(); updateFlagButtons(); if(!isHost){ remote.volume=msg.state.volume; if(msg.state.playing) remote.play().catch(()=>{}); } }
  else if(msg.type==='sync:request' && isHost){ ws.send(JSON.stringify({type:'sync:state', targetId: msg.targetId, state:{playlist, current, flags, volume: audio.volume, playing: !audio.paused}})); }
};

ws.onopen=()=>{
  if(host) ws.send(JSON.stringify({type:'room:create', roomId}));
  else ws.send(JSON.stringify({type:'room:join', roomId}));
};

// --- WebRTC helpers copied/simplified from previous client ---
async function ensureHostStream(){
  if(stream) return stream; if(!audio.captureStream) throw new Error('captureStream unsupported'); stream=audio.captureStream(); return stream;
}
async function hostCreateSenderFor(peerId){
  await ensureHostStream();
  const pcHost=new RTCPeerConnection({iceServers:[{urls:['stun:stun.l.google.com:19302']}]});
  stream.getAudioTracks().forEach(tr=>pcHost.addTrack(tr,stream));
  pcHost.onicecandidate=e=>{ if(e.candidate){ ws.send(JSON.stringify({type:'webrtc:signal', targetId:peerId, payload:{kind:'ice', candidate:e.candidate}})); } };
  peers.set(peerId,{pc:pcHost});
  const offer=await pcHost.createOffer({offerToReceiveAudio:false});
  await pcHost.setLocalDescription(offer);
  ws.send(JSON.stringify({type:'webrtc:signal', targetId:peerId, payload:{kind:'offer', sdp:offer}}));
}
async function ensureListenerPC(){ if(pc) return pc; pc=new RTCPeerConnection({iceServers:[{urls:['stun:stun.l.google.com:19302']}]}); pc.ontrack=e=>{ remote.srcObject=e.streams[0]; }; return pc; }
async function listenerHandleOffer(fromId,sdp){ await ensureListenerPC(); await pc.setRemoteDescription(new RTCSessionDescription(sdp)); const ans=await pc.createAnswer(); await pc.setLocalDescription(ans); ws.send(JSON.stringify({type:'webrtc:signal', targetId:fromId, payload:{kind:'answer', sdp:ans}})); }
const remote=document.createElement('audio');
remote.autoplay=true;
remote.id='remote';
document.body.appendChild(remote);
remote.addEventListener('volumechange',()=>{remote.dataset.userVol='1';});
updateFlagButtons();
