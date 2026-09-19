import { DurableObject } from "cloudflare:workers";
import {
  APP_BUILD, ONLINE_PROTOCOL, EMPTY_ROOM_TTL_MS,
  cors, json, clone, makeRoomCode, createInitialState, setPhysicsProfile,
  applyThrow, applySelectPlayer, applySelectBall, applyLauncher, applyDecline
} from "./game-engine.js";

const HTTP_CONNECTED_MS=15000;

export class BocciaRoom extends DurableObject {
  constructor(ctx,env){
    super(ctx,env);
    this.commandQueue=Promise.resolve();
    this.sessions=new Map();
    this.httpPresence=new Map();
    this.lastReplayPayload=null;
    this.lastHttpActivityWrite=0;

    for(const ws of this.ctx.getWebSockets()){
      const p=ws.deserializeAttachment();
      if(p)this.sessions.set(ws,p);
    }

    this.ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping","pong"));
  }

  serialize(task){
    const work=this.commandQueue.then(task);this.commandQueue=work.catch(()=>{});return work;
  }
  fetch(request){return this.serialize(()=>this.handleRequest(request));}
  async handleRequest(request){
    const url=new URL(request.url);

    if(url.pathname==="/init"&&request.method==="POST"){
      const body=await request.json();
      if(await this.ctx.storage.get('createdAt')){
        if(body.creationId&&body.creationId===await this.ctx.storage.get('creationId'))return json({config:await this.getConfig()});
        return new Response('exists',{status:409});
      }
      if(body.creationId)await this.ctx.storage.put('creationId',body.creationId);
      const config={
        matchFormat:"individual",
        fieldOrientation:body?.config?.fieldOrientation==="horizontal"?"horizontal":"vertical",
        realisticMode:!!body?.config?.realisticMode,
        physicsProfile:{
          w:Number(body?.config?.physicsProfile?.w)||288,
          h:Number(body?.config?.physicsProfile?.h)||600,
          r:Number(body?.config?.physicsProfile?.r)||Math.max(7.8,Math.min(12.5,288*.032))
        }
      };

      await this.ctx.storage.put("createdAt",Date.now());
      await this.ctx.storage.put("roomCode",String(body.code||""));
      await this.ctx.storage.put("config",config);
      await this.ctx.storage.put("revision",0);
      await this.ctx.storage.put("seats",{
        red:{clientKey:String(body.clientKey||"").slice(0,160),ready:false,httpPlayerId:null},
        blue:null
      });
      await this.ctx.storage.put("processedActions",[]);
      await this.ctx.storage.put("lastHttpActivityAt",0);
      await this.ctx.storage.setAlarm(Date.now()+EMPTY_ROOM_TTL_MS);

      return new Response("created",{status:201});
    }

    if(url.pathname==="/exists"){
      const exists=!!await this.ctx.storage.get("createdAt");
      return new Response(exists?"yes":"no",{status:exists?200:404});
    }

    if(!await this.ctx.storage.get("createdAt")){
      return new Response("Room not found",{status:404});
    }

    if(url.pathname==="/http-message"&&request.method==="POST"){
      let body;
      try{body=await request.json()}catch{return json({messages:[],error:"Invalid JSON"},400)}
      const messages=await this.handleHttpMessage(body);
      return json({messages,transport:"https",now:Date.now()});
    }

    if((request.headers.get("Upgrade")||"").toLowerCase()!=="websocket"){
      return new Response("WebSocket required",{status:426});
    }

    await this.ctx.storage.deleteAlarm();

    const pair=new WebSocketPair();
    const [client,server]=Object.values(pair);
    this.ctx.acceptWebSocket(server);

    const player={id:crypto.randomUUID(),clientKey:null,side:null,ready:false};
    server.serializeAttachment(player);
    this.sessions.set(server,player);

    return new Response(null,{status:101,webSocket:client});
  }

  async getSeats(){
    return(await this.ctx.storage.get("seats"))||{red:null,blue:null};
  }

  async getState(){
    const state=(await this.ctx.storage.get("gameState"))||null;
    if(state&&!state.matchId){
      state.matchId=crypto.randomUUID();
      await this.ctx.storage.put("gameState",state);
    }
    return state;
  }

  async getRevision(){
    return Number((await this.ctx.storage.get("revision"))||0);
  }

  async getConfig(){
    return(await this.ctx.storage.get("config"))||{
      matchFormat:"individual",
      fieldOrientation:"vertical",
      realisticMode:false,
      physicsProfile:{w:288,h:600,r:Math.max(7.8,Math.min(12.5,288*.032))}
    };
  }

  pruneHttpPresence(){
    const cutoff=Date.now()-HTTP_CONNECTED_MS;
    for(const[key,p]of this.httpPresence.entries()){
      if(!p||p.lastSeen<cutoff)this.httpPresence.delete(key);
    }
  }

  async touchHttpActivity(){
    const now=Date.now();

    if(!this.lastHttpActivityWrite){
      this.lastHttpActivityWrite=Number((await this.ctx.storage.get("lastHttpActivityAt"))||0);
    }

    if(now-this.lastHttpActivityWrite>=10000){
      this.lastHttpActivityWrite=now;
      await this.ctx.storage.put("lastHttpActivityAt",now);
      // HTTPS has no socket-close event. Keep moving the cleanup deadline
      // while polling is alive so an active fallback match is never deleted.
      await this.ctx.storage.setAlarm(now+EMPTY_ROOM_TTL_MS);
    }
  }

  touchHttpPresence(clientKey,side,id){
    this.pruneHttpPresence();

    const current=this.httpPresence.get(clientKey)||{};
    const next={
      id:id||current.id||crypto.randomUUID(),
      clientKey,
      side:side||current.side||null,
      ready:!!current.ready,
      lastSeen:Date.now()
    };

    this.httpPresence.set(clientKey,next);
    return next;
  }

  async playerList(){
    this.pruneHttpPresence();
    const seats=await this.getSeats();
    const result=[];

    for(const side of["red","blue"]){
      const seat=seats[side];
      if(!seat)continue;

      let connected=false;
      let id=null;

      for(const p of this.sessions.values()){
        if(p.clientKey&&p.clientKey===seat.clientKey){
          connected=true;
          id=p.id;
          break;
        }
      }

      if(!connected){
        const hp=this.httpPresence.get(seat.clientKey);
        if(hp&&hp.lastSeen>=Date.now()-HTTP_CONNECTED_MS){
          connected=true;
          id=seat.httpPlayerId||hp.id;
        }
      }

      result.push({id,side,ready:!!seat.ready,connected});
    }

    return result;
  }

  async roomStatePayload(extra={}){
    return{
      type:"room_state",
      protocol:ONLINE_PROTOCOL,
      build:APP_BUILD,
      players:await this.playerList(),
      config:await this.getConfig(),
      ...extra
    };
  }

  async snapshotPayload(extra={}){
    return{
      type:"snapshot",
      protocol:ONLINE_PROTOCOL,
      build:APP_BUILD,
      revision:await this.getRevision(),
      state:await this.getState(),
      players:await this.playerList(),
      config:await this.getConfig(),
      ...extra
    };
  }

  async broadcast(data){
    const msg=JSON.stringify(data);
    for(const ws of this.ctx.getWebSockets()){
      try{ws.send(msg)}catch{}
    }
  }

  async broadcastRoomState(extra={}){
    await this.broadcast(await this.roomStatePayload(extra));
  }

  async sendSnapshot(ws,extra={}){
    try{ws.send(JSON.stringify(await this.snapshotPayload(extra)))}catch{}
  }

  async processed(actionId){
    if(!actionId)return false;
    const ids=(await this.ctx.storage.get("processedActions"))||[];
    return ids.includes(String(actionId));
  }

  async rememberAction(actionId){
    if(!actionId)return;

    const ids=(await this.ctx.storage.get("processedActions"))||[];
    const id=String(actionId);

    if(!ids.includes(id))ids.push(id);
    while(ids.length>120)ids.shift();

    await this.ctx.storage.put("processedActions",ids);
  }

  async maybeStartGame(triggerActionId=null){
    if(await this.getState())return;

    const seats=await this.getSeats();
    if(!seats.red?.ready||!seats.blue?.ready)return;

    // Readiness belongs to the seat, not to one fragile transport connection.
    // If a player briefly changes Wi-Fi/mobile network here, the match may still
    // start and that player can reconnect into the canonical server state.
    const initial=createInitialState(await this.getConfig());
    initial.revision=1;

    await this.ctx.storage.put("revision",1);
    await this.ctx.storage.put("gameState",initial);

    const payload=await this.snapshotPayload({ackActionId:triggerActionId});
    this.lastReplayPayload=payload;
    await this.broadcast(payload);
  }

  async syncPayload(knownRevision=null,knownMatchId=null){
    const state=await this.getState();
    if(knownMatchId&&knownMatchId!==state?.matchId){
      if(!state)return{type:'restart',protocol:ONLINE_PROTOCOL,build:APP_BUILD};
      return this.snapshotPayload();
    }
    const revision=await this.getRevision();
    const known=Number(knownRevision);

    if(
      Number.isFinite(known)&&
      known<revision&&
      this.lastReplayPayload&&
      Number(this.lastReplayPayload.revision)===revision
    ){
      return {...this.lastReplayPayload,players:await this.playerList()};
    }

    if(Number.isFinite(known)&&known===revision){
      // Heartbeat only. This keeps WebSocket/HTTPS alive and refreshes player
      // presence without retransmitting the full game state every second.
      return this.roomStatePayload({revision});
    }

    return this.snapshotPayload();
  }

  async processGameAction(player,data){
    const actionId=String(data.actionId||"");
    if(!actionId)return{payload:null,broadcast:false};

    if(await this.processed(actionId)){
      return{
        payload:await this.snapshotPayload({ackActionId:actionId}),
        broadcast:false
      };
    }

    const state=await this.getState();
    if(!state){
      return{
        payload:{
          type:"action_error",
          protocol:ONLINE_PROTOCOL,
          build:APP_BUILD,
          message:"Матч ещё не запущен",
          ackActionId:actionId,
          revision:await this.getRevision(),
          state:null
        },
        broadcast:false
      };
    }

    const currentRevision=await this.getRevision();

    if(data.matchId!==state.matchId||data.expectedRevision!==currentRevision){
      return{
        payload:{
          type:"action_error",
          protocol:ONLINE_PROTOCOL,
          build:APP_BUILD,
          message:"Состояние обновилось. Повтори действие.",
          ackActionId:actionId,
          revision:currentRevision,
          state
        },
        broadcast:false
      };
    }

    let next=clone(state);
    let animation=null;
    let events=[];
    let transition=null;

    setPhysicsProfile(next.physicsProfile);

    try{
      if(data.type==="throw"){
        const result=applyThrow(next,player.side,data);
        next=result.state;
        animation=result.animation||null;
        events=result.events||[];
        transition=result.transition||null;
      }
      else if(data.type==="select_player"){
        next=applySelectPlayer(next,player.side,data);
      }
      else if(data.type==="select_ball"){
        next=applySelectBall(next,player.side,data);
      }
      else if(data.type==="set_launcher"){
        next=applyLauncher(next,player.side,data);
      }
      else if(data.type==="decline"){
        const result=applyDecline(next,player.side);
        next=result.state;
        transition=result.transition||null;
      }
      else{
        throw new Error("Неизвестное действие");
      }
    }catch(err){
      await this.rememberAction(actionId);
      return{
        payload:{
          type:"action_error",
          protocol:ONLINE_PROTOCOL,
          build:APP_BUILD,
          message:err?.message||"Действие отклонено",
          ackActionId:actionId,
          revision:await this.getRevision(),
          state
        },
        broadcast:false
      };
    }

    const revision=(await this.getRevision())+1;
    next.revision=revision;

    await this.ctx.storage.put("revision",revision);
    await this.ctx.storage.put("gameState",next);
    await this.rememberAction(actionId);

    const payload=await this.snapshotPayload({
      ackActionId:actionId,
      action:data.type,
      actor:player.side,
      animation,
      events,
      transition
    });

    this.lastReplayPayload=payload;

    return{payload,broadcast:true};
  }

  async applyGameAction(ws,player,data){
    const result=await this.processGameAction(player,data);
    if(!result.payload)return;

    if(result.broadcast){
      await this.broadcast(result.payload);
    }else{
      try{ws.send(JSON.stringify(result.payload))}catch{}
    }
  }

  async joinSeat(clientKey,transport){
    const seats=await this.getSeats();
    let side=null;

    if(seats.red?.clientKey===clientKey)side="red";
    else if(seats.blue?.clientKey===clientKey)side="blue";
    else if(!seats.red){
      side="red";
      seats.red={clientKey,ready:false,httpPlayerId:null};
    }
    else if(!seats.blue){
      side="blue";
      seats.blue={clientKey,ready:false,httpPlayerId:null};
    }
    else{
      return{full:true,seats,side:null};
    }

    if(transport==="http"){
      const seat=seats[side]||{clientKey,ready:false};
      if(!seat.httpPlayerId)seat.httpPlayerId=crypto.randomUUID();
      seats[side]=seat;
    }

    await this.ctx.storage.put("seats",seats);
    return{full:false,seats,side};
  }

  async handleHttpJoin(data,clientKey,sessionId=null){
    if(data.protocol!==ONLINE_PROTOCOL||data.build!==APP_BUILD){
      return[{
        type:"room_state",
        protocol:ONLINE_PROTOCOL,
        build:APP_BUILD
      }];
    }

    clientKey=String(clientKey||data.clientKey||"").slice(0,160);
    if(!clientKey)return[];

    const joined=await this.joinSeat(clientKey,"http");
    if(joined.full){
      return[{
        type:"room_full",
        protocol:ONLINE_PROTOCOL,
        build:APP_BUILD
      }];
    }

    const side=joined.side;
    const seat=joined.seats[side];
    if(sessionId){seat.httpSessionId=sessionId;await this.ctx.storage.put("seats",joined.seats);}

    // HTTPS takeover replaces a stale native WebSocket belonging to the same
    // clientKey. This prevents the old transport from making the player look
    // connected twice during a network switch.
    for(const[otherWs,other]of this.sessions.entries()){
      if(other.clientKey&&other.clientKey===clientKey){
        this.sessions.delete(otherWs);
        try{otherWs.close(4002,"http-fallback")}catch{}
      }
    }

    const player=this.touchHttpPresence(clientKey,side,seat.httpPlayerId);
    player.ready=!!seat.ready;

    await this.touchHttpActivity();
    await this.maybeStartGame(null);

    return[
      {
        type:"joined",
        protocol:ONLINE_PROTOCOL,
        build:APP_BUILD,
        playerId:seat.httpPlayerId,
        side,
        ready:!!seat.ready,
        revision:await this.getRevision(),
        state:await this.getState(),
        players:await this.playerList(),
        config:await this.getConfig()
      },
      await this.roomStatePayload()
    ];
  }

  async handleHttpMessage(body){
    const data=body?.message;
    const suppliedClientKey=String(body?.clientKey||"").slice(0,160);

    if(!data||typeof data!=="object")return[];

    if(data.type==="join"){
      return this.handleHttpJoin(data,suppliedClientKey,String(body.sessionId||"").slice(0,160)||null);
    }

    const clientKey=suppliedClientKey;
    if(!clientKey)return[];

    const seats=await this.getSeats();
    let side=null;

    if(seats.red?.clientKey===clientKey)side="red";
    else if(seats.blue?.clientKey===clientKey)side="blue";
    else{
      return[{
        type:"room_full",
        protocol:ONLINE_PROTOCOL,
        build:APP_BUILD
      }];
    }

    const seat=seats[side];
    if(body.sessionId&&seat.httpSessionId&&body.sessionId!==seat.httpSessionId){
      return[{type:'session_replaced',protocol:ONLINE_PROTOCOL,build:APP_BUILD}];
    }
    const player=this.touchHttpPresence(clientKey,side,seat.httpPlayerId||crypto.randomUUID());
    player.ready=!!seat.ready;

    await this.touchHttpActivity();

    if(data.type==="sync"){
      await this.maybeStartGame(null);
      return[await this.syncPayload(data.knownRevision,data.knownMatchId)];
    }

    if(data.type==="ready"){
      const actionId=String(data.actionId||"");
      if(!actionId)return[];

      if(await this.processed(actionId)){
        const out=[await this.roomStatePayload({ackActionId:actionId})];
        await this.maybeStartGame(actionId);
        if(await this.getState())out.push(await this.snapshotPayload({ackActionId:actionId}));
        return out;
      }

      if(await this.getState()){
        await this.rememberAction(actionId);
        return[await this.snapshotPayload({ackActionId:actionId})];
      }

      const nextSeats=await this.getSeats();
      if(!nextSeats[side]||nextSeats[side].clientKey!==clientKey)return[];

      nextSeats[side].ready=!!data.ready;
      player.ready=!!data.ready;

      await this.ctx.storage.put("seats",nextSeats);
      await this.rememberAction(actionId);

      const roomState=await this.roomStatePayload({ackActionId:actionId});
      await this.broadcast(roomState);
      await this.maybeStartGame(actionId);

      const out=[roomState];
      if(await this.getState())out.push(await this.snapshotPayload({ackActionId:actionId}));
      return out;
    }

    if(["throw","select_player","select_ball","set_launcher","decline"].includes(data.type)){
      const result=await this.processGameAction(player,data);
      if(!result.payload)return[];
      if(result.broadcast)await this.broadcast(result.payload);
      return[result.payload];
    }

    if(data.type==="restart"){
      const actionId=String(data.actionId||"");
      if(!actionId)return[];

      if(await this.processed(actionId)){
        return[await this.roomStatePayload({ackActionId:actionId})];
      }

      const state=await this.getState();
      if(!state||data.matchId!==state.matchId){
        return[await this.snapshotPayload({ackActionId:actionId})];
      }

      await this.ctx.storage.delete("gameState");
      await this.ctx.storage.put("revision",0);
      await this.ctx.storage.put("processedActions",[]);
      await this.rememberAction(actionId);

      const nextSeats=await this.getSeats();
      if(nextSeats.red)nextSeats.red.ready=false;
      if(nextSeats.blue)nextSeats.blue.ready=false;
      await this.ctx.storage.put("seats",nextSeats);

      for(const[socket,p]of this.sessions.entries()){
        p.ready=false;
        socket.serializeAttachment(p);
        this.sessions.set(socket,p);
      }
      for(const p of this.httpPresence.values())p.ready=false;

      this.lastReplayPayload=null;

      const restart={
        type:"restart",
        protocol:ONLINE_PROTOCOL,
        build:APP_BUILD,
        ackActionId:actionId
      };

      await this.broadcast(restart);
      const roomState=await this.roomStatePayload();
      await this.broadcast(roomState);

      return[restart,roomState];
    }

    if(data.type==="leave"){
      const nextSeats=await this.getSeats();
      if(nextSeats[side]?.clientKey===clientKey){
        nextSeats[side]=null;
        await this.ctx.storage.put("seats",nextSeats);
      }

      this.httpPresence.delete(clientKey);

      const roomState=await this.roomStatePayload();
      await this.broadcast(roomState);
      await this.scheduleCleanupIfEmpty();

      return[roomState];
    }

    return[await this.roomStatePayload()];
  }

  webSocketMessage(ws,message){return this.serialize(()=>this.handleSocketMessage(ws,message));}
  async handleSocketMessage(ws,message){
    let data;
    try{data=JSON.parse(message)}catch{return}

    let player=this.sessions.get(ws)||ws.deserializeAttachment()||{
      id:crypto.randomUUID(),clientKey:null,side:null,ready:false
    };

    if(!data||typeof data!=="object")return;

    if(data.type==="join"){
      if(data.protocol!==ONLINE_PROTOCOL||data.build!==APP_BUILD){
        ws.send(JSON.stringify({
          type:"room_state",
          protocol:ONLINE_PROTOCOL,
          build:APP_BUILD
        }));
        return;
      }

      const clientKey=String(data.clientKey||"").slice(0,160);
      if(!clientKey)return;

      const joined=await this.joinSeat(clientKey,"ws");
      if(joined.full){
        ws.send(JSON.stringify({
          type:"room_full",
          protocol:ONLINE_PROTOCOL,
          build:APP_BUILD
        }));
        return;
      }

      const side=joined.side;
      const seats=joined.seats;

      for(const[otherWs,other]of this.sessions.entries()){
        if(otherWs!==ws&&other.clientKey&&other.clientKey===clientKey){
          this.sessions.delete(otherWs);
          try{otherWs.close(4001,"reconnected")}catch{}
        }
      }

      player={
        id:crypto.randomUUID(),
        clientKey,
        side,
        ready:!!seats[side]?.ready
      };

      seats[side]={
        ...(seats[side]||{}),
        clientKey,
        ready:player.ready
      };

      await this.ctx.storage.put("seats",seats);

      ws.serializeAttachment(player);
      this.sessions.set(ws,player);
      await this.ctx.storage.deleteAlarm();

      ws.send(JSON.stringify({
        type:"joined",
        protocol:ONLINE_PROTOCOL,
        build:APP_BUILD,
        playerId:player.id,
        side:player.side,
        ready:player.ready,
        revision:await this.getRevision(),
        state:await this.getState(),
        players:await this.playerList(),
        config:await this.getConfig()
      }));

      await this.broadcastRoomState();
      await this.maybeStartGame(null);
      return;
    }

    if(!player.side||!this.sessions.has(ws))return;

    const activeSeats=await this.getSeats();
    if(activeSeats[player.side]?.clientKey!==player.clientKey)return;

    if(data.type==="sync"){
      try{ws.send(JSON.stringify(await this.syncPayload(data.knownRevision,data.knownMatchId)))}catch{}
      return;
    }

    if(data.type==="ready"){
      const actionId=String(data.actionId||"");
      if(!actionId)return;

      if(await this.processed(actionId)){
        ws.send(JSON.stringify(await this.roomStatePayload({ackActionId:actionId})));
        await this.maybeStartGame(actionId);
        return;
      }

      if(await this.getState()){
        await this.rememberAction(actionId);
        await this.sendSnapshot(ws,{ackActionId:actionId});
        return;
      }

      const seats=await this.getSeats();
      if(!seats[player.side]||seats[player.side].clientKey!==player.clientKey)return;

      seats[player.side].ready=!!data.ready;
      player.ready=!!data.ready;

      ws.serializeAttachment(player);
      this.sessions.set(ws,player);

      await this.ctx.storage.put("seats",seats);
      await this.rememberAction(actionId);
      await this.broadcastRoomState({ackActionId:actionId});
      await this.maybeStartGame(actionId);
      return;
    }

    if(["throw","select_player","select_ball","set_launcher","decline"].includes(data.type)){
      await this.applyGameAction(ws,player,data);
      return;
    }

    if(data.type==="restart"){
      const actionId=String(data.actionId||"");
      if(!actionId||await this.processed(actionId))return;

      const state=await this.getState();
      if(!state||data.matchId!==state.matchId){
        await this.sendSnapshot(ws,{ackActionId:actionId});
        return;
      }

      await this.ctx.storage.delete("gameState");
      await this.ctx.storage.put("revision",0);
      await this.ctx.storage.put("processedActions",[]);
      await this.rememberAction(actionId);

      const seats=await this.getSeats();
      if(seats.red)seats.red.ready=false;
      if(seats.blue)seats.blue.ready=false;
      await this.ctx.storage.put("seats",seats);

      for(const[socket,p]of this.sessions.entries()){
        p.ready=false;
        socket.serializeAttachment(p);
        this.sessions.set(socket,p);
      }
      for(const p of this.httpPresence.values())p.ready=false;

      this.lastReplayPayload=null;

      await this.broadcast({
        type:"restart",
        protocol:ONLINE_PROTOCOL,
        build:APP_BUILD,
        ackActionId:actionId||null
      });
      await this.broadcastRoomState();
      return;
    }

    if(data.type==="leave"){
      const seats=await this.getSeats();
      if(player.side&&seats[player.side]?.clientKey===player.clientKey){
        seats[player.side]=null;
        await this.ctx.storage.put("seats",seats);
      }

      this.sessions.delete(ws);
      await this.broadcastRoomState();

      try{ws.close(1000,"leave")}catch{}
      await this.scheduleCleanupIfEmpty();
      return;
    }
  }

  async scheduleCleanupIfEmpty(){
    this.pruneHttpPresence();

    if(this.ctx.getWebSockets().length>0||this.httpPresence.size>0){
      try{await this.ctx.storage.deleteAlarm()}catch{}
      return;
    }

    const lastHttp=Number((await this.ctx.storage.get("lastHttpActivityAt"))||0);
    const base=Math.max(Date.now(),lastHttp);
    await this.ctx.storage.setAlarm(base+EMPTY_ROOM_TTL_MS);
  }

  async webSocketClose(ws){
    this.sessions.delete(ws);
    await this.broadcastRoomState();
    await this.scheduleCleanupIfEmpty();
  }

  async webSocketError(ws){
    this.sessions.delete(ws);
    await this.broadcastRoomState();
    await this.scheduleCleanupIfEmpty();
  }

  async alarm(){
    this.pruneHttpPresence();

    const sockets=this.ctx.getWebSockets().length;
    const lastHttp=Number((await this.ctx.storage.get("lastHttpActivityAt"))||0);
    const httpRecentlyActive=Date.now()-lastHttp<EMPTY_ROOM_TTL_MS;

    if(sockets===0&&this.httpPresence.size===0&&!httpRecentlyActive){
      await this.ctx.storage.deleteAll();
      this.sessions.clear();
      this.httpPresence.clear();
      this.lastReplayPayload=null;
      return;
    }

    await this.ctx.storage.setAlarm(Date.now()+EMPTY_ROOM_TTL_MS);
  }
}

