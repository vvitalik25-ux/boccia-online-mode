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
const qs='/create-room?clientKey=red&requestId=same&physicsW=288&physicsH=600&physicsR=9.216';const created=await Promise.all([api(qs),api(qs)]);assert.equal(created[0].code,created[1].code);assert.equal(rooms.size,1);const code=created[0].code;
const msg=async(key,message)=>(await api('/http/room/'+code+'/message',{clientKey:key,message})).messages;
const join={type:'join',build:'2026-09-06-online-stability-1',protocol:'exact-1v1-v4'};
assert.equal((await msg('red',join))[0].side,'red');
const candidates=await Promise.all([msg('blue',join),msg('third',join)]);assert.equal(candidates.filter(x=>x[0].type==='joined').length,1);assert.equal(candidates.filter(x=>x[0].type==='room_full').length,1);
await msg('red',{type:'ready',ready:true,actionId:'ready-r'});let out=await msg('blue',{type:'ready',ready:true,actionId:'ready-b'});let state=out.find(x=>x.state).state;assert(state.matchId);
const throwMessage={type:'throw',angle:0,power:.5,actionId:'throw-1',expectedRevision:state.revision,matchId:state.matchId};
const owner=state.phase.toLowerCase().includes('blue')?'blue':'red';out=await Promise.all([msg(owner,throwMessage),msg(owner,throwMessage)]);assert.equal(out[0][0].revision,out[1][0].revision);assert.equal(out[0][0].revision,state.revision+1);
const before=state;state=out[0][0].state;
await msg('red',{type:'restart',actionId:'restart',matchId:state.matchId});out=await msg('blue',{type:'sync',knownRevision:state.revision,knownMatchId:state.matchId});assert.equal(out[0].type,'restart');
await msg('red',{type:'ready',ready:true,actionId:'ready-r2'});out=await msg('blue',{type:'ready',ready:true,actionId:'ready-b2'});const second=out.find(x=>x.state).state;assert.notEqual(second.matchId,before.matchId);
out=await msg('red',{type:'sync',knownRevision:1,knownMatchId:before.matchId});assert.equal(out[0].state.matchId,second.matchId);
const cors=await c.worker.fetch(new Request('https://test/http/room/'+code+'/message',{method:'OPTIONS'}),env);assert.equal(cors.status,204);
await api('/http/room/'+code+'/message',{clientKey:'red',sessionId:'old-tab',message:join});
await api('/http/room/'+code+'/message',{clientKey:'red',sessionId:'new-tab',message:join});
const oldLeave=await api('/http/room/'+code+'/message',{clientKey:'red',sessionId:'old-tab',message:{type:'leave'}});assert.equal(oldLeave.messages[0].type,'session_replaced');assert.equal((await rooms.get(code).getSeats()).red.clientKey,'red');
console.log('PASS: idempotent concurrent room creation, seat race, HTTPS join/ready, duplicate throw, peer restart, new match at same revision, CORS');
})().catch(e=>{console.error(e);process.exitCode=1});
