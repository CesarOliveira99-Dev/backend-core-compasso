export class RateLimiter {
  private readonly windows = new Map<string,{count:number;resetAt:number}>();
  private sweptAt=0;
  allow(key:string,limit:number,now=Date.now(),duration=60000) {
    if(now-this.sweptAt>=duration){for(const [key,value] of this.windows)if(value.resetAt<=now)this.windows.delete(key);this.sweptAt=now;}
    let entry=this.windows.get(key);
    if(!entry || entry.resetAt<=now){if(!entry && this.windows.size>=10000)return false;entry={count:0,resetAt:now+duration};this.windows.set(key,entry);}
    if(entry.count>=limit)return false;
    entry.count++;return true;
  }
}
