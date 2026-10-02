const http=require('http');
const crypto=require('crypto');

const sessions=new Map();
let server=null;

function kind(url){const p=new URL(url).pathname.toLowerCase();if(p.endsWith('.m3u8'))return'm3u8';if(p.endsWith('.png')||p.endsWith('.webp'))return'segment';return'other'}
function encode(value){return Buffer.from(value).toString('base64url')}
function proxyUrl(port,id,url){return `http://127.0.0.1:${port}/__flix/${id}/${encode(url)}`}
// Media playlists also note each segment's place, so the segments after the one asked for can be fetched ahead.
function rewrite(text,base,id,port){const list=[],lines=text.split(/\r?\n/).map(line=>{const t=line.trim();if(!t)return line;if(t.startsWith('#'))return line.replace(/URI="([^"]+)"/gi,(_,u)=>`URI="${proxyUrl(port,id,new URL(u,base).href)}"`);const url=new URL(t,base).href;list.push(url);return proxyUrl(port,id,url)});const data=sessions.get(id);if(data)list.forEach((url,index)=>data.order.set(url,{list,index}));return lines.join('\n')}
function decodeManifest(body,pk,url,id,port){let text=body.toString('latin1').trim();if(!text.startsWith('#EXTM3U')){const encrypted=Buffer.from(text,'base64'),key=Buffer.from(pk.trim(),'base64');if(!key.length)throw new Error('FlixCloud 키가 비어 있습니다.');const plain=Buffer.alloc(encrypted.length);for(let i=0;i<encrypted.length;i++)plain[i]=encrypted[i]^key[i%key.length];text=plain.toString('utf8').trim();if(!text.startsWith('#EXTM3U'))throw new Error('FlixCloud 재생목록 복호화에 실패했습니다.')}return Buffer.from(rewrite(text,url,id,port))}
function decodeSegment(body){let payload;if(body.length>=12&&body.subarray(0,4).toString()==='RIFF'&&body.subarray(8,12).toString()==='WEBP')payload=Buffer.from(body.subarray(12));else if(body.length>=8&&body.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])))payload=Buffer.from(body.subarray(8));else return body;if(!payload.length||payload[0]===71)return payload;const key=Buffer.from([157,42,241,71,179,142,92,112,166,25,228,59,216,98,15,197]);for(let i=0;i<payload.length;i++)payload[i]^=key[i%key.length];return payload}
// A decoded media segment must be MPEG-TS (0x47 sync every 188 bytes) or fragmented MP4.
function isMedia(body){if(body[0]===0x47&&(body.length<=188||body[188]===0x47))return true;const box=body.subarray(4,8).toString('latin1');return ['ftyp','styp','moof','sidx','emsg'].includes(box)}
// Some CDNs wrap segments in other fake image headers; find where the TS stream starts.
function findTs(body){const limit=Math.min(body.length-376,4096);for(let i=1;i<limit;i++)if(body[i]===0x47&&body[i+188]===0x47&&body[i+376]===0x47)return body.subarray(i);return null}
// The CDN behind FlixCloud is reached through a far-away edge that gives each file a few hundred KB/s and now and
// then stalls a request for a minute. It answers ranges, so a segment is fetched as several ranges at once, a range
// that is slow to arrive is asked for again alongside, and several segments ahead of playback are on the way at once.
const PART=1024*1024,PARTS=6,AHEAD=5,KEEP=16,HEDGE_MS=8000;
const ahead=new Map();
// One range, asked for up to three times (the next one after HEDGE_MS, or at once when one fails); the first good
// answer is used and the rest are stopped.
function fetchHedged(target,headers,start,end){return new Promise((resolve,reject)=>{
  const controllers=[];let pending=0,timer=null,settled=false,lastError=null;
  const finish=(error,result)=>{if(settled)return;settled=true;clearTimeout(timer);controllers.forEach(controller=>controller.abort());error?reject(error):resolve(result)};
  const launch=()=>{
    if(settled)return;
    if(controllers.length>=3){if(!pending)finish(lastError);return}
    const controller=new AbortController();controllers.push(controller);pending++;
    clearTimeout(timer);timer=setTimeout(launch,HEDGE_MS);
    fetch(target,{headers:{...headers,range:`bytes=${start}-${end}`},signal:controller.signal}).then(async response=>{
      const body=Buffer.from(await response.arrayBuffer());
      if(start>0?response.status!==206||body.length!==end-start+1:!response.ok)throw new Error(`영상 조각을 받지 못했습니다 (${response.status}).`);
      finish(null,{response,body});
    }).catch(error=>{pending--;lastError=error;if(!pending)launch()});
  };
  launch();
})}
async function fetchRanges(target,headers){
  const {response:first,body:head}=await fetchHedged(target,headers,0,PART-1),total=Number(first.headers.get('content-range')?.split('/')[1]);
  if(first.status!==206||!(total>head.length))return {upstream:first,raw:head};
  const ranges=[];for(let start=head.length;start<total;start+=PART)ranges.push([start,Math.min(start+PART,total)-1]);
  const parts=new Array(ranges.length);let next=0;
  await Promise.all(Array.from({length:Math.min(PARTS,ranges.length)},async()=>{while(next<ranges.length){const i=next++;parts[i]=(await fetchHedged(target,headers,...ranges[i])).body}}));
  return {upstream:first,raw:Buffer.concat([head,...parts])};
}
// A segment already on the way (fetched ahead, or asked for twice by player and download) is not fetched again.
async function fetchSegment(target,headers){let job=ahead.get(target);if(!job){job=fetchRanges(target,headers);job.catch(()=>{});ahead.set(target,job)}try{return await job}finally{ahead.delete(target)}}
// While one segment plays, the next ones are already on the way.
function fetchAhead(data,target,headers){const place=data.order.get(target);if(!place)return;
  for(const url of place.list.slice(place.index+1,place.index+1+AHEAD)){if(ahead.has(url))continue;const job=fetchRanges(url,headers);job.catch(()=>{});ahead.set(url,job)}
  while(ahead.size>KEEP)ahead.delete(ahead.keys().next().value)}
async function handle(req,res){try{const parts=new URL(req.url,'http://127.0.0.1').pathname.split('/').filter(Boolean);if(parts.length<3||parts[0]!=='__flix'){res.writeHead(404).end();return}const data=sessions.get(parts[1]);if(!data){res.writeHead(410).end();return}if(parts[2]==='master.m3u8'&&data.videoUrl&&data.audioUrl){const port=server.address().port,video=proxyUrl(port,parts[1],data.videoUrl),audio=proxyUrl(port,parts[1],data.audioUrl);const body=Buffer.from(`#EXTM3U\n#EXT-X-VERSION:7\n#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",NAME="Default",DEFAULT=YES,AUTOSELECT=YES,URI="${audio}"\n#EXT-X-STREAM-INF:BANDWIDTH=5000000,AUDIO="audio"\n${video}\n`);res.writeHead(200,{'content-type':'application/vnd.apple.mpegurl','content-length':body.length,'access-control-allow-origin':'*','cache-control':'no-store'});res.end(body);return}const target=Buffer.from(parts.slice(2).join('/'),'base64url').toString();const headers={};for(const [k,v]of Object.entries(data.headers||{}))if(['user-agent','referer','origin','cookie','accept','accept-language'].includes(k.toLowerCase())&&v)headers[k]=v;const type=kind(target);let upstream,raw,body;
  // The player asks for one video and one audio segment at a time; more at once is a download, which asks for the
  // following segments itself.
  if(type==='segment'){data.active=(data.active||0)+1;res.on('close',()=>data.active--);if(data.active<=2)fetchAhead(data,target,headers)}
  // Media segments are validated after decoding; a CDN occasionally answers with something else,
  // so refetch twice and otherwise fail the request (hls.js retries loads, but a parse error is fatal).
  for(let attempt=0;attempt<3;attempt++){
    if(type==='segment')({upstream,raw}=await (attempt?fetchRanges(target,headers):fetchSegment(target,headers)));
    else{upstream=await fetch(target,{headers});raw=Buffer.from(await upstream.arrayBuffer())}
    if(!upstream.ok){res.writeHead(upstream.status,{'content-type':upstream.headers.get('content-type')||'text/plain'});res.end(raw);return}
    if(type==='m3u8'){body=decodeManifest(raw,data.pk,target,parts[1],server.address().port);break}
    body=decodeSegment(raw);if(isMedia(body))break;
    const ts=findTs(body)||findTs(raw);if(ts){body=ts;break}
    if(type!=='segment'&&!/\.(ts|m4s|mp4|webp|png|jpe?g|gif|ico|js|css|html?)$/i.test(new URL(target).pathname)){body=raw;break}
    body=null;
  }
  if(!body)throw new Error('영상 조각 데이터가 올바르지 않습니다.');res.writeHead(200,{'content-type':type==='m3u8'?'application/vnd.apple.mpegurl':type==='segment'?'video/mp4':upstream.headers.get('content-type')||'application/octet-stream','content-length':body.length,'access-control-allow-origin':'*','cache-control':'no-store','accept-ranges':'none'});res.end(req.method==='HEAD'?undefined:body)}catch(error){const body=Buffer.from(`FLIX_DECODE_FAILED: ${error.message}`);res.writeHead(502,{'content-type':'text/plain; charset=utf-8','content-length':body.length});res.end(body)}}
async function ensureServer(){if(server?.listening)return;server=http.createServer(handle);await new Promise((resolve,reject)=>server.once('error',reject).listen(0,'127.0.0.1',resolve))}
async function createFlixProxyUrl(url,pk,headers={}){await ensureServer();const id=crypto.randomUUID().replaceAll('-','');sessions.set(id,{pk,headers,order:new Map()});return proxyUrl(server.address().port,id,url)}
async function createFlixAvProxyUrl(videoUrl,audioUrl,pk,headers={}){await ensureServer();const id=crypto.randomUUID().replaceAll('-','');sessions.set(id,{pk,headers,videoUrl,audioUrl,order:new Map()});return `http://127.0.0.1:${server.address().port}/__flix/${id}/master.m3u8`}
function closeFlixProxy(){sessions.clear();ahead.clear();server?.close();server=null}

module.exports={createFlixProxyUrl,createFlixAvProxyUrl,closeFlixProxy};
