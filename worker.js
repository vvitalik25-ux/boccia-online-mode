import { APP_BUILD, ONLINE_PROTOCOL, cors, json, makeRoomCode } from "./game-engine.js";
export { BocciaRoom } from "./room.js";

export default {
  async fetch(request,env){
    const url=new URL(request.url);
    if(request.method==="OPTIONS")return new Response(null,{status:204,headers:cors()});
    if(url.pathname==="/version"){
      return json({
        build:APP_BUILD,
        protocol:ONLINE_PROTOCOL,
        now:Date.now()
      },200,{
        "Cache-Control":"no-store, no-cache, must-revalidate, max-age=0",
        "Pragma":"no-cache",
        "Expires":"0"
      });
    }

    if(url.pathname==="/"||url.pathname==="/health"){
      return new Response(`Boccia ${ONLINE_PROTOCOL} · ${APP_BUILD} — OK`,{
        headers:cors({
          "Content-Type":"text/plain; charset=utf-8",
          "Cache-Control":"no-store, no-cache, must-revalidate, max-age=0"
        })
      });
    }

    if(url.pathname==="/create-room"){
      if(!env.BOCCIA_ROOMS)return json({error:"BOCCIA_ROOMS binding missing"},500);
      const clientKey=String(url.searchParams.get("clientKey")||"").slice(0,160);if(!clientKey)return json({error:"clientKey required"},400);
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
        const code=makeRoomCode(),id=env.BOCCIA_ROOMS.idFromName(code),stub=env.BOCCIA_ROOMS.get(id);
        const init=await stub.fetch(new Request("https://room.internal/init",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({code,clientKey,config})}));
        if(init.status===201)return json({code,config,build:APP_BUILD,protocol:ONLINE_PROTOCOL},201);
        if(init.status!==409)return json({error:"Could not create room"},500);
      }
      return json({error:"Could not allocate room code"},503);
    }

    if(url.pathname.startsWith("/room-check/")){
      const code=url.pathname.split("/")[2]?.toUpperCase().replace(/[^A-Z0-9]/g,"");
      if(!code||code.length<4||code.length>8)return json({exists:false},404);
      const stub=env.BOCCIA_ROOMS.get(env.BOCCIA_ROOMS.idFromName(code)),r=await stub.fetch("https://room.internal/exists");
      return r.status===200?json({exists:true,build:APP_BUILD,protocol:ONLINE_PROTOCOL}):json({exists:false,build:APP_BUILD,protocol:ONLINE_PROTOCOL},404);
    }

    if(url.pathname.startsWith("/room/")){
      const code=url.pathname.split("/")[2]?.toUpperCase().replace(/[^A-Z0-9]/g,"");
      if(!code||code.length<4||code.length>8)return new Response("Invalid room code",{status:400});
      if((request.headers.get("Upgrade")||"").toLowerCase()!=="websocket")return new Response("WebSocket required",{status:426});
      return env.BOCCIA_ROOMS.get(env.BOCCIA_ROOMS.idFromName(code)).fetch(request);
    }
    return new Response("Not found",{status:404,headers:cors()});
  }
};

