// Six minutes per side per end. Persisted deadlines survive worker eviction.
const LIMIT=360000;
const sideOf=s=>s.phase==='red'||s.phase==='jackRed'?'red':s.phase==='blue'||s.phase==='jackBlue'?'blue':null;
function newClock(s,now=Date.now()){
  return {remaining:{red:LIMIT,blue:LIMIT},side:sideOf(s),activeAt:now};
}
function clockRemaining(c,side,now=Date.now()){
  return Math.max(0,c.remaining[side]-(c.side===side?Math.max(0,now-c.activeAt):0));
}
function settleClock(c,now=Date.now()){
  if(c?.side)c.remaining[c.side]=clockRemaining(c,c.side,now);
  if(c)c.activeAt=Math.max(c.activeAt,now);
}
function nextClock(before,after,now,duration=0,transition=null){
  if(!before.clock)return null;
  const c=structuredClone(before.clock);
  settleClock(c,now);
  if(c.side)c.remaining[c.side]=Math.max(0,c.remaining[c.side]-duration);
  const startsAt=now+duration+(transition?1450:0);
  const result=transition&&after.phase!=='finished'?newClock(after,startsAt):c;
  result.side=sideOf(after);result.activeAt=startsAt;
  return result;
}
export {newClock,clockRemaining,settleClock,nextClock,sideOf};
