const socket=io();
const token=decodeURIComponent(location.pathname.split('/').pop() || '');
const rtcConfig={iceServers:[
{urls:'stun:stun.l.google.com:19302'},
{urls:'stun:stun1.l.google.com:19302'},
{urls:'stun:stun.cloudflare.com:3478'}
],iceCandidatePoolSize:10};

let pc=null;
let stream=null;
let facingMode='environment';

const status=document.getElementById('status');
const preview=document.getElementById('preview');

function setStatus(value){status.textContent=value;}

function joinPair(){
  socket.emit('phone-camera-join',{token},response=>{
    if(response && response.ok){
      setStatus('Ligado ao computador. Toque em Ativar câmera.');
    }else{
      setStatus((response && response.error) || 'Link inválido ou expirado.');
    }
  });
}

async function startCamera(){
  try{
    if(stream) stream.getTracks().forEach(track=>track.stop());

    stream=await navigator.mediaDevices.getUserMedia({
      video:{
        facingMode:{ideal:facingMode},
        width:{ideal:1920},
        height:{ideal:1080},
        frameRate:{ideal:30,max:30}
      },
      audio:false
    });

    preview.srcObject=stream;

    if(pc){try{pc.close()}catch{}}
    pc=new RTCPeerConnection(rtcConfig);

    const videoTrack=stream.getVideoTracks()[0];

    if(!videoTrack){
      setStatus('Nenhuma câmera disponível.');
      return;
    }

    pc.addTransceiver(videoTrack,{
      direction:'sendonly',
      streams:[stream]
    });

    pc.onicecandidate=event=>{
      if(event.candidate){
        socket.emit('phone-camera-ice',{token,candidate:event.candidate});
      }
    };

    pc.onconnectionstatechange=()=>{
      if(pc.connectionState==='connected') setStatus('Câmera conectada ao computador.');
      if(pc.connectionState==='failed') setStatus('Falha de conexão. Tente novamente.');
    };

    const offer=await pc.createOffer();
    await pc.setLocalDescription(offer);

    socket.emit('phone-camera-offer',{token,sdp:pc.localDescription});
    setStatus('Enviando câmera para o computador...');
  }catch(error){
    console.error(error);
    setStatus('Autorize o acesso à câmera no celular.');
  }
}

socket.on('connect',joinPair);

socket.on('phone-camera-answer',async data=>{
  if(!pc || data.token!==token || !data.sdp) return;
  try{await pc.setRemoteDescription(data.sdp)}catch(error){console.error(error)}
});

socket.on('phone-camera-ice',async data=>{
  if(!pc || data.token!==token || !data.candidate) return;
  try{await pc.addIceCandidate(data.candidate)}catch{}
});

socket.on('phone-camera-stopped',()=>{
  setStatus('O computador encerrou a conexão.');
  if(stream) stream.getTracks().forEach(track=>track.stop());
  if(pc) pc.close();
  pc=null;
});

document.getElementById('startBtn').addEventListener('click',startCamera);
document.getElementById('flipBtn').addEventListener('click',async()=>{
  facingMode=facingMode==='environment' ? 'user' : 'environment';
  await startCamera();
});
window.addEventListener('beforeunload',()=>socket.emit('phone-camera-stop',{token}));
