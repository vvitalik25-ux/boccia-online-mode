import { APP_BUILD, ONLINE_PROTOCOL, cors, json, makeRoomCode } from "./game-engine.js";
export { BocciaRoom } from "./room.js";

function transportCors(headers={}){
  return cors({
    "Access-Control-Allow-Methods":"GET,POST,OPTIONS",
    "Access-Control-Allow-Headers":"Content-Type, Cache-Control, Pragma",
    ...headers
  });
}

function transportJson(data,status=200){
  return new Response(JSON.stringify(data),{
    status,
    headers:transportCors({
      "Content-Type":"application/json; charset=utf-8",
      "Cache-Control":"no-store, no-cache, must-revalidate, max-age=0",
      "Pragma":"no-cache",
      "Expires":"0"
    })
  });
}

function roomCodeFromPath(pathname,prefix){
  const rest=pathname.slice(prefix.length);
  return (rest.split("/")[0]||"").toUpperCase().replace(/[^A-Z0-9]/g,"");
}

async function creationKey(clientKey,requestId,attempt){
  const bytes=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify([clientKey,requestId,attempt])));
  return Array.from(new Uint8Array(bytes),b=>b.toString(16).padStart(2,'0')).join('');
}
export default {
  async fetch(request,env){
    const url=new URL(request.url);

    if(request.method==="OPTIONS"){
      return new Response(null,{status:204,headers:transportCors()});
    }

    if(url.pathname==="/version"){
      return transportJson({
        build:APP_BUILD,
        protocol:ONLINE_PROTOCOL,
        transport:"ws+https",
        now:Date.now()
      });
    }

    if(url.pathname==="/"||url.pathname==="/health"){
      return new Response(`Boccia ${ONLINE_PROTOCOL} · ${APP_BUILD} · WS+HTTPS — OK`,{
        headers:transportCors({
          "Content-Type":"text/plain; charset=utf-8",
          "Cache-Control":"no-store, no-cache, must-revalidate, max-age=0"
        })
      });
    }

    if(url.pathname==="/create-room"){
      if(!env.BOCCIA_ROOMS)return transportJson({error:"BOCCIA_ROOMS binding missing"},500);

      const clientKey=String(url.searchParams.get("clientKey")||"").slice(0,160);
      if(!clientKey)return transportJson({error:"clientKey required"},400);

      const requestId=String(url.searchParams.get("requestId")||"").slice(0,160);
      const pw=Number(url.searchParams.get("physicsW"));
      const ph=Number(url.searchParams.get("physicsH"));
      const pr=Number(url.searchParams.get("physicsR"));

      const config={
        matchFormat:"individual",
        fieldOrientation:url.searchParams.get("orientation")==="horizontal"?"horizontal":"vertical",
        realisticMode:url.searchParams.get("realism")==="1",
        physicsProfile:{
          w:Number.isFinite(pw)?pw:288,
          h:Number.isFinite(ph)?ph:600,
          r:Number.isFinite(pr)?pr:Math.max(7.8,Math.min(12.5,288*.032))
        }
      };

      for(let attempt=0;attempt<12;attempt++){
        const creationId=requestId?await creationKey(clientKey,requestId,attempt):null;
        const alphabet='ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
        const code=creationId?Array.from({length:8},(_,i)=>alphabet[parseInt(creationId.slice(i*2,i*2+2),16)%32]).join(''):makeRoomCode();
        const id=env.BOCCIA_ROOMS.idFromName(code);
        const stub=env.BOCCIA_ROOMS.get(id);
        const init=await stub.fetch(new Request("https://room.internal/init",{
          method:"POST",
          headers:{"Content-Type":"application/json"},
          body:JSON.stringify({code,clientKey,config,creationId})
        }));

        if(init.status===200){
          const saved=await init.json();
          return transportJson({code,config:saved.config,build:APP_BUILD,protocol:ONLINE_PROTOCOL},200);
        }
        if(init.status===201){
          return transportJson({code,config,build:APP_BUILD,protocol:ONLINE_PROTOCOL},201);
        }
        if(init.status!==409){
          return transportJson({error:"Could not create room"},500);
        }
      }

      return transportJson({error:"Could not allocate room code"},503);
    }

    if(url.pathname.startsWith("/room-check/")){
      const code=roomCodeFromPath(url.pathname,"/room-check/");
      if(!code||code.length<4||code.length>8)return transportJson({exists:false},404);

      const stub=env.BOCCIA_ROOMS.get(env.BOCCIA_ROOMS.idFromName(code));
      const r=await stub.fetch("https://room.internal/exists");

      return r.status===200
        ?transportJson({exists:true,build:APP_BUILD,protocol:ONLINE_PROTOCOL})
        :transportJson({exists:false,build:APP_BUILD,protocol:ONLINE_PROTOCOL},404);
    }

    // HTTPS fallback transport. It carries the same protocol messages that
    // normally travel over WebSocket.
    if(url.pathname.startsWith("/http/room/")&&url.pathname.endsWith("/message")){
      if(request.method!=="POST")return transportJson({error:"POST required"},405);

      const code=roomCodeFromPath(url.pathname,"/http/room/");
      if(!code||code.length<4||code.length>8)return transportJson({error:"Invalid room code"},400);

      let body;
      try{body=await request.json()}catch{return transportJson({error:"Invalid JSON"},400)}

      const stub=env.BOCCIA_ROOMS.get(env.BOCCIA_ROOMS.idFromName(code));
      const response=await stub.fetch(new Request("https://room.internal/http-message",{
        method:"POST",
        headers:{"Content-Type":"application/json"},
        body:JSON.stringify(body)
      }));

      const text=await response.text();
      return new Response(text,{
        status:response.status,
        headers:transportCors({
          "Content-Type":"application/json; charset=utf-8",
          "Cache-Control":"no-store, no-cache, must-revalidate, max-age=0",
          "Pragma":"no-cache",
          "Expires":"0"
        })
      });
    }

    if(url.pathname.startsWith("/room/")){
      const code=roomCodeFromPath(url.pathname,"/room/");
      if(!code||code.length<4||code.length>8)return new Response("Invalid room code",{status:400});

      if((request.headers.get("Upgrade")||"").toLowerCase()!=="websocket"){
        return new Response("WebSocket required",{status:426,headers:transportCors()});
      }

      return env.BOCCIA_ROOMS.get(env.BOCCIA_ROOMS.idFromName(code)).fetch(request);
    }

    return new Response("Not found",{status:404,headers:transportCors()});
  }
};

