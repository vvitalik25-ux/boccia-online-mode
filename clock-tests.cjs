const fs=require('fs'),vm=require('vm'),assert=require('assert/strict'),crypto=require('crypto').webcrypto;
const c=vm.createContext({console,crypto,Response,Request,URL,TextEncoder,WebSocketRequestResponsePair:class{},DurableObject:class{constructor(ctx){this.ctx=ctx}},structuredClone});
let engine=fs.readFileSync(__dirname+'/game-engine.js','utf8').replace(/export \{[^}]+\};?/g,'');
let room=fs.readFileSync(__dirname+'/room.js','utf8').replace(/import[\s\S]*?from ["'][^"']+["'];/g,'').replace('export class','class');
let worker=fs.readFileSync(__dirname+'/worker.js','utf8').replace(/import[^\n]+\n/g,'').replace(/export \{[^\n]+\n/g,'').replace('export default','globalThis.worker=');
const clock=fs.readFileSync(__dirname+'/match-clock.js','utf8').replace(/export \{[^}]+\};?/g,'');
vm.runInContext(engine+'\n'+clock+'\n'+room+'\nglobalThis.Room=BocciaRoom;\n'+worker,c);
const rooms=new Map();function ctx(){const m=new Map();return{m,storage:{get:async k=>structuredClone(m.get(k)),put:async(k,v)=>m.set(k,structuredClone(v)),delete:async k=>m.delete(k),setAlarm:async()=>{},deleteAlarm:async()=>{},deleteAll:async()=>m.clear()},getWebSockets:()=>[],setWebSocketAutoResponse(){}}}
const env={BOCCIA_ROOMS:{idFromName:s=>s,get(code){if(!rooms.has(code))rooms.set(code,new c.Room(ctx(),{}));return{fetch:r=>rooms.get(code).fetch(typeof r==='string'?new Request(r):r)}}}};
const api=async(path,body)=>{const r=await c.worker.fetch(new Request('https://test'+path,body?{method:'POST',headers:{'Content-Type':'text/plain;charset=UTF-8'},body:JSON.stringify(body)}:{}),env);assert(r.ok,'HTTP '+r.status);return r.json()};
(async()=>{
const created=await api('/create-room?clientKey=red&requestId=timed&timed=1&physicsW=288&physicsH=600&physicsR=9.216');
const code=created.code,room=rooms.get(code);
assert.equal(created.config.timedMode,true);
const msg=async(key,message)=>(await api('/http/room/'+code+'/message',{clientKey:key,message})).messages;
const join={type:'join',build:'2026-09-06-online-stability-1',protocol:'exact-1v1-v4'};
await msg('red',join);await msg('blue',join);await msg('red',{type:'ready',ready:true,actionId:'r'});
let out=await msg('blue',{type:'ready',ready:true,actionId:'b'}),state=out.find(x=>x.state).state;
assert.equal(state.clock.remaining.red,360000);assert.equal(state.clock.side,'red');
// Expire the jack deadline; all unused red balls become dead and blue gets jack.
state.clock.activeAt=Date.now()-360001;await room.ctx.storage.put('gameState',state);
out=await msg('red',{type:'sync',knownRevision:state.revision});state=(await room.getState());
assert.equal(state.redLeft,0);assert.equal(state.phase,'jackBlue');assert.equal(state.clock.remaining.red,0);assert.equal(state.clock.remaining.blue,360000);
// Persisted clock survives a new DO instance, even without either player's poll.
const restarted=new c.Room(room.ctx,{});state.clock.activeAt=Date.now()-360001;await room.ctx.storage.put('gameState',state);
await restarted.alarm();state=await restarted.getState();
assert.equal(state.endNo,2);assert.equal(state.clock.remaining.red,360000);assert.equal(state.clock.remaining.blue,360000);
// A ball released before zero is resolved; flight time counts, remaining balls expire.
state.clock.activeAt=Date.now();state.clock.remaining.blue=10;await room.ctx.storage.put('gameState',state);
out=await room.processGameAction({side:'blue'},{type:'throw',actionId:'last-second',expectedRevision:state.revision,matchId:state.matchId,angle:0,power:.5});
assert(out.payload.animation.frames.length>0);state=out.payload.state;assert.equal(state.blueLeft,0);assert.equal(state.clock.remaining.blue,0);
assert(state.clock.activeAt>Date.now());
// Untimed rooms remain unchanged.
const untimed=await api('/create-room?clientKey=x&requestId=untimed');assert.equal(untimed.config.timedMode,false);
console.log('PASS: six-minute clock, jack expiry, dead balls, persisted alarm, end reset, legal last-second release, untimed config');
})().catch(e=>{console.error(e);process.exitCode=1});
