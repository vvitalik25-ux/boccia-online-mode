import { DurableObject } from "cloudflare:workers";
import { APP_BUILD, ONLINE_PROTOCOL, EMPTY_ROOM_TTL_MS, cors, json, clone, makeRoomCode, createInitialState, setPhysicsProfile, applyThrow, applySelectPlayer, applySelectBall, applyLauncher, applyDecline } from "./game-engine.js";

export class BocciaRoom extends DurableObject {
  constructor(ctx,env){
    super(ctx,env);this.sessions=new Map();
    for(const ws of this.ctx.getWebSockets()){const p=ws.deserializeAttachment();if(p)this.sessions.set(ws,p)}
    this.ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping","pong"));
  }
  async fetch(request){
    const url=new URL(request.url);
    if(url.pathname==="/init"&&request.method==="POST"){
      if(await this.ctx.storage.get("createdAt"))return new Response("exists",{status:409});
      const body=await request.json(),config={
        matchFormat:"individual",
        fieldOrientation:body?.config?.fieldOrientation==="horizontal"?"horizontal":"vertical",
        realisticMode:!!body?.config?.realisticMode,
        physicsProfile:{
          w:Number(body?.config?.physicsProfile?.w)||288,
          h:Number(body?.config?.physicsProfile?.h)||600,
          r:Number(body?.config?.physicsProfile?.r)||Math.max(7.8,Math.min(12.5,288*.032))
        }
      };
      await this.ctx.storage.put("createdAt",Date.now());await this.ctx.storage.put("roomCode",String(body.code||""));
      await this.ctx.storage.put("config",config);await this.ctx.storage.put("revision",0);
      await this.ctx.storage.put("seats",{red:{clientKey:String(body.clientKey||"").slice(0,160),ready:false},blue:null});
      await this.ctx.storage.put("processedActions",[]);await this.ctx.storage.setAlarm(Date.now()+EMPTY_ROOM_TTL_MS);
      return new Response("created",{status:201});
    }
    if(url.pathname==="/exists")return new Response(await this.ctx.storage.get("createdAt")?"yes":"no",{status:await this.ctx.storage.get("createdAt")?200:404});
    if(!await this.ctx.storage.get("createdAt"))return new Response("Room not found",{status:404});
    if((request.headers.get("Upgrade")||"").toLowerCase()!=="websocket")return new Response("WebSocket required",{status:426});
    await this.ctx.storage.deleteAlarm();
    const pair=new WebSocketPair(),[client,server]=Object.values(pair);this.ctx.acceptWebSocket(server);
    const player={id:crypto.randomUUID(),clientKey:null,side:null,ready:false};server.serializeAttachment(player);this.sessions.set(server,player);
    return new Response(null,{status:101,webSocket:client});
  }
  async getSeats(){return(await this.ctx.storage.get("seats"))||{red:null,blue:null}}
  async getState(){
    const state=(await this.ctx.storage.get("gameState"))||null;
    if(state&&!state.matchId){state.matchId=crypto.randomUUID();await this.ctx.storage.put("gameState",state)}
    return state;
  }
  async getRevision(){return Number((await this.ctx.storage.get("revision"))||0)}
  async getConfig(){return(await this.ctx.storage.get("config"))||{
    matchFormat:"individual",
    fieldOrientation:"vertical",
    realisticMode:false,
    physicsProfile:{w:288,h:600,r:Math.max(7.8,Math.min(12.5,288*.032))}
  }}
  async playerList(){
    const seats=await this.getSeats(),result=[];
    for(const side of["red","blue"]){
      const seat=seats[side];if(!seat)continue;let connected=false,id=null;
      for(const p of this.sessions.values())if(p.clientKey&&p.clientKey===seat.clientKey){connected=true;id=p.id;break}
      result.push({id,side,ready:!!seat.ready,connected});
    }
    return result;
  }
  async roomStatePayload(extra={}){return{type:"room_state",protocol:ONLINE_PROTOCOL,build:APP_BUILD,players:await this.playerList(),config:await this.getConfig(),...extra}}
  async snapshotPayload(extra={}){return{type:"snapshot",protocol:ONLINE_PROTOCOL,build:APP_BUILD,revision:await this.getRevision(),state:await this.getState(),players:await this.playerList(),config:await this.getConfig(),...extra}}
  async broadcast(data){const msg=JSON.stringify(data);for(const ws of this.ctx.getWebSockets())try{ws.send(msg)}catch{}}
  async broadcastRoomState(extra={}){await this.broadcast(await this.roomStatePayload(extra))}
  async sendSnapshot(ws,extra={}){try{ws.send(JSON.stringify(await this.snapshotPayload(extra)))}catch{}}
  async processed(actionId){if(!actionId)return false;const ids=(await this.ctx.storage.get("processedActions"))||[];return ids.includes(String(actionId))}
  async rememberAction(actionId){
    if(!actionId)return;const ids=(await this.ctx.storage.get("processedActions"))||[],id=String(actionId);
    if(!ids.includes(id))ids.push(id);while(ids.length>80)ids.shift();await this.ctx.storage.put("processedActions",ids);
  }
  async maybeStartGame(triggerActionId=null){
    if(await this.getState())return;
    const seats=await this.getSeats();if(!seats.red?.ready||!seats.blue?.ready)return;
    const ps=await this.playerList();if(!ps.find(p=>p.side==="red")?.connected||!ps.find(p=>p.side==="blue")?.connected)return;
    const initial=createInitialState(await this.getConfig());initial.revision=1;
    await this.ctx.storage.put("revision",1);await this.ctx.storage.put("gameState",initial);
    await this.broadcast(await this.snapshotPayload({ackActionId:triggerActionId}));
  }
  async applyGameAction(ws,player,data){
    const actionId=String(data.actionId||"");if(!actionId)return;
    if(await this.processed(actionId)){await this.sendSnapshot(ws,{ackActionId:actionId});return}
    const state=await this.getState();
    if(!state){ws.send(JSON.stringify({type:"action_error",protocol:ONLINE_PROTOCOL,build:APP_BUILD,message:"Матч ещё не запущен",ackActionId:actionId,revision:await this.getRevision(),state:null}));return}
    if(data.matchId!==state.matchId||data.expectedRevision!==await this.getRevision()){
      ws.send(JSON.stringify({type:"action_error",protocol:ONLINE_PROTOCOL,build:APP_BUILD,message:"Состояние обновилось. Повтори действие.",ackActionId:actionId,revision:await this.getRevision(),state}));
      return;
    }
    let next=clone(state);
    let animation=null;
    let events=[];
    let transition=null;

    // Use exactly the creator's local 1 × 1 court geometry.
    setPhysicsProfile(next.physicsProfile);

    try{
      if(data.type==="throw"){
        const result=applyThrow(next,player.side,data);
        next=result.state;
        animation=result.animation||null;
        events=result.events||[];
        transition=result.transition||null;
      }
      else if(data.type==="select_player")next=applySelectPlayer(next,player.side,data);
      else if(data.type==="select_ball")next=applySelectBall(next,player.side,data);
      else if(data.type==="set_launcher")next=applyLauncher(next,player.side,data);
      else if(data.type==="decline"){
        const result=applyDecline(next,player.side);
        next=result.state;
        transition=result.transition||null;
      }
      else throw new Error("Неизвестное действие");
    }catch(err){
      await this.rememberAction(actionId);
      ws.send(JSON.stringify({type:"action_error",protocol:ONLINE_PROTOCOL,build:APP_BUILD,message:err?.message||"Действие отклонено",ackActionId:actionId,revision:await this.getRevision(),state}));
      return;
    }
    const revision=(await this.getRevision())+1;next.revision=revision;
    await this.ctx.storage.put("revision",revision);await this.ctx.storage.put("gameState",next);await this.rememberAction(actionId);
    await this.broadcast(await this.snapshotPayload({
      ackActionId:actionId,
      action:data.type,
      actor:player.side,
      animation,
      events,
      transition
    }));
  }
  async webSocketMessage(ws,message){
    let data;try{data=JSON.parse(message)}catch{return}
    let player=this.sessions.get(ws)||ws.deserializeAttachment()||{id:crypto.randomUUID(),clientKey:null,side:null,ready:false};

    if(!data||typeof data!=="object")return;
    if(data.type==="join"){
      if(data.protocol!==ONLINE_PROTOCOL||data.build!==APP_BUILD){
        ws.send(JSON.stringify({type:"room_state",protocol:ONLINE_PROTOCOL,build:APP_BUILD}));
        return;
      }
      const clientKey=String(data.clientKey||"").slice(0,160);if(!clientKey)return;
      const seats=await this.getSeats();let side=null;
      if(seats.red?.clientKey===clientKey)side="red";else if(seats.blue?.clientKey===clientKey)side="blue";
      else if(!seats.red){side="red";seats.red={clientKey,ready:false}}else if(!seats.blue){side="blue";seats.blue={clientKey,ready:false}}
      else{ws.send(JSON.stringify({type:"room_full",protocol:ONLINE_PROTOCOL,build:APP_BUILD}));return}
      for(const[otherWs,other]of this.sessions.entries())if(otherWs!==ws&&other.clientKey&&other.clientKey===clientKey){this.sessions.delete(otherWs);try{otherWs.close(4001,"reconnected")}catch{}}
      player={id:crypto.randomUUID(),clientKey,side,ready:!!seats[side]?.ready};seats[side]={clientKey,ready:player.ready};
      await this.ctx.storage.put("seats",seats);ws.serializeAttachment(player);this.sessions.set(ws,player);await this.ctx.storage.deleteAlarm();
      ws.send(JSON.stringify({type:"joined",protocol:ONLINE_PROTOCOL,build:APP_BUILD,playerId:player.id,side:player.side,ready:player.ready,revision:await this.getRevision(),state:await this.getState(),players:await this.playerList(),config:await this.getConfig()}));
      await this.broadcastRoomState();return;
    }
    if(!player.side||!this.sessions.has(ws))return;
    const activeSeats=await this.getSeats();
    if(activeSeats[player.side]?.clientKey!==player.clientKey)return;
    if(data.type==="sync"){await this.sendSnapshot(ws);return}
    if(data.type==="ready"){
      const actionId=String(data.actionId||"");if(!actionId)return;
      if(await this.processed(actionId)){ws.send(JSON.stringify(await this.roomStatePayload({ackActionId:actionId})));await this.maybeStartGame(actionId);return}
      if(await this.getState()){await this.rememberAction(actionId);await this.sendSnapshot(ws,{ackActionId:actionId});return}
      const seats=await this.getSeats();if(!seats[player.side]||seats[player.side].clientKey!==player.clientKey)return;
      seats[player.side].ready=!!data.ready;player.ready=!!data.ready;ws.serializeAttachment(player);this.sessions.set(ws,player);
      await this.ctx.storage.put("seats",seats);await this.rememberAction(actionId);await this.broadcastRoomState({ackActionId:actionId});await this.maybeStartGame(actionId);return;
    }
    if(["throw","select_player","select_ball","set_launcher","decline"].includes(data.type)){await this.applyGameAction(ws,player,data);return}
    if(data.type==="restart"){
      const actionId=String(data.actionId||"");
      if(!actionId||await this.processed(actionId))return;
      const state=await this.getState();
      if(!state||data.matchId!==state.matchId){await this.sendSnapshot(ws,{ackActionId:actionId});return}
      await this.ctx.storage.delete("gameState");await this.ctx.storage.put("revision",0);await this.ctx.storage.put("processedActions",[]);await this.rememberAction(actionId);
      const seats=await this.getSeats();if(seats.red)seats.red.ready=false;if(seats.blue)seats.blue.ready=false;await this.ctx.storage.put("seats",seats);
      for(const[socket,p]of this.sessions.entries()){p.ready=false;socket.serializeAttachment(p);this.sessions.set(socket,p)}
      await this.broadcast({type:"restart",protocol:ONLINE_PROTOCOL,build:APP_BUILD,ackActionId:actionId||null});await this.broadcastRoomState();return;
    }
    if(data.type==="leave"){
      const seats=await this.getSeats();if(player.side&&seats[player.side]?.clientKey===player.clientKey){seats[player.side]=null;await this.ctx.storage.put("seats",seats)}
      this.sessions.delete(ws);await this.broadcastRoomState();try{ws.close(1000,"leave")}catch{}await this.scheduleCleanupIfEmpty();return;
    }
  }
  async scheduleCleanupIfEmpty(){if(this.ctx.getWebSockets().length===0)await this.ctx.storage.setAlarm(Date.now()+EMPTY_ROOM_TTL_MS)}
  async webSocketClose(ws){this.sessions.delete(ws);await this.broadcastRoomState();await this.scheduleCleanupIfEmpty()}
  async webSocketError(ws){this.sessions.delete(ws);await this.broadcastRoomState();await this.scheduleCleanupIfEmpty()}
  async alarm(){if(this.ctx.getWebSockets().length===0){await this.ctx.storage.deleteAll();this.sessions.clear();return}await this.ctx.storage.deleteAlarm()}
}
