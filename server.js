const express = require('express');
const http    = require('http');
const { Server } = require('socket.io');
const path    = require('path');

const app    = express();
const server = http.createServer(app);
const io     = new Server(server, {
  pingTimeout:  30000,
  pingInterval: 10000,
  transports:   ['websocket','polling'],
});
app.use(express.static(path.join(__dirname, 'public')));

// ─── Constants ────────────────────────────────────────────────────
const GW = 800, GH = 800;
const WALL       = 14;
const PAD_W      = 14;
const PAD_LEN    = 180;   // doubled from 90
const BALL_R     = 12;
const APPLE_R    = 17;
const INIT_SPD   = 280;
const MAX_SPD    = 560;
const ACCEL_RATE = 5;
const LIVES      = 3;
const FPS        = 40;
const COLL_TOL   = 7;
const SPIN       = 0.32;
const AI_NORM    = 255;
const AI_HARD    = 370;
const AI_REACT   = 0.13;

const INDIAN_NAMES = [
  'Aiyana','Akando','Alaqua','Aponi','Aquene','Askook','Avonaco','Bidziil',
  'Cetan','Chayton','Cheyenne','Cochise','Dakota','Dyami','Elan','Enola',
  'Halona','Hiawatha','Honovi','Hototo','Huritt','Inteus','Istas','Kangi',
  'Kaya','Keokuk','Kohana','Koko','Kuruk','Lenape','Luta','Mahpee','Maka',
  'Makwa','Mato','Mingan','Nahele','Namid','Napayshni','Nashoba','Nita',
  'Nokomis','Ohanzee','Ohitika','Onida','Pakwa','Pavati','Sahale','Sapa',
  'Shilah','Shuman','Sihu','Suni','Takoda','Tallulah','Tasunka','Tawa',
  'Tokala','Tocho','Wambli','Wapasha','Waya','Winona','Wohali','Yahto',
  'Zaltana','Kangee','Mahkah','Miwak','Ogima','Paytah','Unkechaug',
];
function rndName(used) {
  const pool = INDIAN_NAMES.filter(n => !used.includes(n));
  return pool[Math.floor(Math.random()*pool.length)] || 'Waya';
}

const rooms = {};
function uid4() {
  return [...Array(4)].map(()=>'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'[Math.floor(Math.random()*32)]).join('');
}
function midAxis(s) { return (s==='left'||s==='right') ? GH/2 : GW/2; }
function effLen(room, s) {
  return room.powerups[s]?.type==='big' ? PAD_LEN*BIG_FACTOR : PAD_LEN;
}

function makeRoom(mode, botSides, difficulty) {
  const id    = uid4();
  const sides = mode===2 ? ['left','right'] : ['left','right','top','bottom'];
  const used  = [];
  const bNames = {};
  (botSides||[]).forEach(s => { const n=rndName(used); used.push(n); bNames[s]=n; });
  const room = {
    id, mode, sides,
    difficulty: difficulty||'normal',
    bots:    Object.fromEntries((botSides||[]).map(s=>[s,true])),
    names:   Object.fromEntries(sides.map(s=>[s, bNames[s]||''])),
    players: {},
    phase:   'lobby',
    interval:null, starInterval:null, appleInterval:null, fireballInterval:null,
    lastTick:0, ball:null,
    stars:[], apples:[], fireballs:[],
    paddles:  Object.fromEntries(sides.map(s=>[s,{pos:midAxis(s)-PAD_LEN/2,alive:true}])),
    lives:    Object.fromEntries(sides.map(s=>[s,LIVES])),
    scores:   Object.fromEntries(sides.map(s=>[s,0])),
    lasers:   Object.fromEntries(sides.map(s=>[s,null])),
    powerups: Object.fromEntries(sides.map(s=>[s,null])),
    paddleVel:Object.fromEntries(sides.map(s=>[s,0])),
    prevPos:  Object.fromEntries(sides.map(s=>[s,midAxis(s)-PAD_LEN/2])),
    aiTarget: Object.fromEntries(sides.map(s=>[s,midAxis(s)-PAD_LEN/2])),
    lastPad:  null,
  };
  rooms[id]=room; return room;
}

function spawnBall(room) {
  const alive=room.sides.filter(s=>room.paddles[s]?.alive);
  const t=alive[Math.floor(Math.random()*alive.length)];
  const base={left:Math.PI,right:0,top:-Math.PI/2,bottom:Math.PI/2};
  const angle=(base[t]||0)+(Math.random()-.5)*Math.PI*.5;
  room.ball={
    x:GW/2,y:GH/2,
    vx:Math.cos(angle)*INIT_SPD, vy:Math.sin(angle)*INIT_SPD,
    frozen:false, freezeTimer:0, freezeVx:0, freezeVy:0,
    frozenSide:null, frozenOff:0,
    fire:false, fireTimer:0,
  };
  room.lastPad=null;
}

function startGame(room) {
  room.phase='playing'; spawnBall(room); room.lastTick=Date.now();
  // Only apples — spawn first after 10s, then every 12s
  setTimeout(()=>{
    if(room.phase!=='playing')return; spawnItem(room,'apple');
    room.appleInterval=setInterval(()=>{if(room.phase==='playing'&&room.apples.length<1)spawnItem(room,'apple');},12000);
  },10000);
  room.interval=setInterval(()=>tick(room),1000/FPS);
}

function spawnItem(room,type) {
  const item={id:Math.random().toString(36).substr(2,6),x:GW*.22+Math.random()*GW*.56,y:GH*.22+Math.random()*GH*.56};
  if(type==='star')room.stars.push(item);
  else if(type==='apple')room.apples.push(item);
  else room.fireballs.push(item);
  broadcast(room);
}

function tickBots(room,dt) {
  if(!room.ball)return;
  const b=room.ball, spd=room.difficulty==='hard'?AI_HARD:AI_NORM;
  for(const side of room.sides) {
    if(!room.bots[side])continue;
    const pad=room.paddles[side]; if(!pad?.alive)continue;
    const isV=side==='left'||side==='right';
    const eLen=effLen(room,side);
    const ideal=(isV?b.y:b.x)-eLen/2;
    room.aiTarget[side]+=(ideal-room.aiTarget[side])*Math.min(1,dt/AI_REACT);
    const diff=room.aiTarget[side]-pad.pos;
    const move=Math.sign(diff)*Math.min(Math.abs(diff),spd*dt);
    const lim=(isV?GH:GW)-WALL-PAD_W-eLen;
    pad.pos=Math.max(WALL+PAD_W,Math.min(lim,pad.pos+move));
  }
}

function tick(room) {
  const now=Date.now(), dt=Math.min((now-room.lastTick)/1000,0.05);
  room.lastTick=now;
  const ball=room.ball; if(!ball)return;

  for(const s of room.sides) {
    if(room.powerups[s]){room.powerups[s].timer-=dt;if(room.powerups[s].timer<=0)room.powerups[s]=null;}
  }

  // Paddle velocity tracking
  for(const s of room.sides) {
    const raw=(room.paddles[s].pos-room.prevPos[s])/Math.max(dt,0.001);
    room.paddleVel[s]=room.paddleVel[s]*.6+raw*.4;
    room.prevPos[s]=room.paddles[s].pos;
  }

  tickBots(room,dt);

  // Frozen ball moves with paddle
  if(ball.frozen) {
    ball.freezeTimer-=dt;
    if(ball.frozenSide) {
      const pad=room.paddles[ball.frozenSide];
      if(pad) {
        if(ball.frozenSide==='left'||ball.frozenSide==='right') ball.y=pad.pos+ball.frozenOff;
        else ball.x=pad.pos+ball.frozenOff;
      }
    }
    if(ball.freezeTimer<=0){ball.frozen=false;ball.frozenSide=null;ball.vx=ball.freezeVx;ball.vy=ball.freezeVy;}
    broadcast(room); return;
  }

  ball.x+=ball.vx*dt; ball.y+=ball.vy*dt;

  // Gradual acceleration
  const curSpd=Math.hypot(ball.vx,ball.vy);
  const newSpd=Math.min(curSpd+ACCEL_RATE*dt,MAX_SPD);
  if(curSpd>0){ball.vx=ball.vx/curSpd*newSpd;ball.vy=ball.vy/curSpd*newSpd;}

  // Apple → +1 life for the last paddle that hit the ball
  room.apples=room.apples.filter(ap=>{
    if(Math.hypot(ball.x-ap.x,ball.y-ap.y)<BALL_R+APPLE_R){
      if(room.lastPad){
        room.lives[room.lastPad]=Math.min(room.lives[room.lastPad]+1, LIVES+2);
        broadcast(room);
      }
      return false;
    }
    return true;
  });

  if(checkBounds(room,ball))return;
  broadcast(room);
}

function checkBounds(room,ball) {
  const ch=[
    {s:'left',  pHit:ball.x-BALL_R<=WALL+PAD_W,  wHit:ball.x-BALL_R<=WALL},
    {s:'right', pHit:ball.x+BALL_R>=GW-WALL-PAD_W,wHit:ball.x+BALL_R>=GW-WALL},
    {s:'top',   pHit:ball.y-BALL_R<=WALL+PAD_W,  wHit:ball.y-BALL_R<=WALL},
    {s:'bottom',pHit:ball.y+BALL_R>=GH-WALL-PAD_W,wHit:ball.y+BALL_R>=GH-WALL},
  ];
  for(const{s,pHit,wHit}of ch) {
    if(!room.sides.includes(s)){if(!wHit)continue;wBounce(ball,s);}
    else {
      const pad=room.paddles[s];
      if(!pad?.alive){if(!wHit)continue;wBounce(ball,s);}
      else {
        if(!pHit)continue;
        const isV=s==='left'||s==='right';
        const eLen=effLen(room,s);
        const bp=isV?ball.y:ball.x;
        if(bp>=pad.pos-COLL_TOL&&bp<=pad.pos+eLen+COLL_TOL){
          pBounce(ball,s,room); room.lastPad=s; room.scores[s]++;
        } else {loseLife(room,s);return true;}
      }
    }
  }
  return false;
}

function pBounce(b,s,room) {
  const vel=room.paddleVel[s]||0, spin=vel*SPIN, f=1.02;
  const clamp=v=>Math.max(-MAX_SPD*.75,Math.min(MAX_SPD*.75,v));
  if(s==='left')  {b.vx= Math.abs(b.vx)*f;b.x=WALL+PAD_W+BALL_R+1;b.vy=clamp(b.vy+spin);}
  if(s==='right') {b.vx=-Math.abs(b.vx)*f;b.x=GW-WALL-PAD_W-BALL_R-1;b.vy=clamp(b.vy+spin);}
  if(s==='top')   {b.vy= Math.abs(b.vy)*f;b.y=WALL+PAD_W+BALL_R+1;b.vx=clamp(b.vx+spin);}
  if(s==='bottom'){b.vy=-Math.abs(b.vy)*f;b.y=GH-WALL-PAD_W-BALL_R-1;b.vx=clamp(b.vx+spin);}
}
function wBounce(b,s) {
  if(s==='left')  {b.vx= Math.abs(b.vx);b.x=WALL+BALL_R+1;}
  if(s==='right') {b.vx=-Math.abs(b.vx);b.x=GW-WALL-BALL_R-1;}
  if(s==='top')   {b.vy= Math.abs(b.vy);b.y=WALL+BALL_R+1;}
  if(s==='bottom'){b.vy=-Math.abs(b.vy);b.y=GH-WALL-BALL_R-1;}
}

function loseLife(room,side) {
  room.lives[side]=Math.max(0,room.lives[side]-1);
  room.ball=null; broadcast(room);
  if(room.lives[side]===0) {
    room.paddles[side].alive=false;
    const alive=room.sides.filter(s=>room.paddles[s]?.alive);
    if(alive.length<=1){endGame(room);return;}
  }
  setTimeout(()=>{if(room.phase==='playing'){spawnBall(room);broadcast(room);}},1500);
}

function endGame(room) {
  room.phase='gameover';
  clearInterval(room.interval);
  clearInterval(room.appleInterval);
  const winner=room.sides.find(s=>room.paddles[s]?.alive)||null;
  io.to(room.id).emit('gameover',{winner,scores:room.scores,names:room.names});
  setTimeout(()=>delete rooms[room.id],60000);
}

function broadcast(room) {
  io.to(room.id).emit('state',{
    ball:room.ball, paddles:room.paddles,
    stars:room.stars, apples:room.apples, fireballs:room.fireballs,
    lasers:room.lasers, powerups:room.powerups,
    scores:room.scores, lives:room.lives,
    bots:room.bots, names:room.names,
  });
}

io.on('connection',socket=>{
  // Solo: always 1 player vs 3 AI
  socket.on('solo',({difficulty,name})=>{
    const room=makeRoom(4,['right','top','bottom'],difficulty||'normal');
    room.players[socket.id]='left';
    room.names['left']=(name||'Игрок').slice(0,16);
    socket.join(room.id);
    socket.emit('joined',{roomId:room.id,side:'left',solo:true});
    io.to(room.id).emit('countdown',{});
    setTimeout(()=>startGame(room),3000);
  });

  socket.on('create',({mode,name})=>{
    const room=makeRoom(parseInt(mode)||4,[]);
    room.players[socket.id]=room.sides[0];
    room.names[room.sides[0]]=(name||'Игрок').slice(0,16);
    socket.join(room.id);
    socket.emit('joined',{roomId:room.id,side:room.sides[0]});
    io.to(room.id).emit('lobby',{players:[room.sides[0]],mode:room.mode,names:room.names});
  });

  socket.on('join',({roomId,name})=>{
    const room=rooms[roomId?.toUpperCase()];
    if(!room)return socket.emit('err','Комната не найдена');
    if(room.phase!=='lobby')return socket.emit('err','Игра уже идёт');
    const taken=Object.values(room.players);
    const free=room.sides.filter(s=>!taken.includes(s));
    if(!free.length)return socket.emit('err','Комната заполнена');
    const side=free[0];
    room.players[socket.id]=side;
    room.names[side]=(name||'Игрок').slice(0,16);
    socket.join(room.id);
    socket.emit('joined',{roomId:room.id,side});
    const all=Object.values(room.players);
    io.to(room.id).emit('lobby',{players:all,mode:room.mode,names:room.names});
    if(all.length===room.mode){io.to(room.id).emit('countdown',{});setTimeout(()=>startGame(room),3000);}
  });

  socket.on('move',({pos})=>{
    const room=Object.values(rooms).find(r=>r.players[socket.id]);
    if(!room||room.phase!=='playing')return;
    const side=room.players[socket.id], pad=room.paddles[side];
    if(!pad)return;
    const isV=side==='left'||side==='right';
    const eLen=effLen(room,side);
    const lim=(isV?GH:GW)-WALL-PAD_W-eLen;
    pad.pos=Math.max(WALL+PAD_W,Math.min(lim,pos));
  });

  socket.on('disconnect',()=>{
    const room=Object.values(rooms).find(r=>r.players[socket.id]);
    if(!room)return;
    delete room.players[socket.id];
    if(room.phase==='playing'){
      clearInterval(room.interval);
      clearInterval(room.appleInterval);
      room.phase='gameover';
      io.to(room.id).emit('playerLeft',{});
    }
  });
});

const PORT=process.env.PORT||3000;
server.listen(PORT,()=>console.log(`Quad Pong v5  →  http://localhost:${PORT}`));
