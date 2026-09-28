const http=require('http');
const crypto=require('crypto');

const sessions=new Map();
let server=null;

function kind(url){const p=new URL(url).pathname.toLowerCase();if(p.endsWith('.m3u8'))return'm3u8';if(p.endsWith('.png')||p.endsWith('.webp'))return'segment';return'other'}
function encode(value){return Buffer.from(value).toString('base64url')}
function proxyUrl(port,id,url){return `http://127.0.0.1:${port}/__flix/${id}/${encode(url)}`}
function rewrite(text,base,id,port){return text.split(/\r?\n/).map(line=>{const t=line.trim();if(!t)return line;if(t.startsWith('#'))return line.replace(/URI="([^"]+)"/gi,(_,u)=>`URI="${proxyUrl(port,id,new URL(u,base).href)}"`);return proxyUrl(port,id,new URL(t,base).href)}).join('\n')}
function decodeManifest(body,pk,url,id,port){let text=body.toString('latin1').trim();if(!text.startsWith('#EXTM3U')){const encrypted=Buffer.from(text,'base64'),key=Buffer.from(pk.trim(),'base64');if(!key.length)throw new Error('FlixCloud 키가 비어 있습니다.');const plain=Buffer.alloc(encrypted.length);for(let i=0;i<encrypted.length;i++)plain[i]=encrypted[i]^key[i%key.length];text=plain.toString('utf8').trim();if(!text.startsWith('#EXTM3U'))throw new Error('FlixCloud 재생목록 복호화에 실패했습니다.')}return Buffer.from(rewrite(text,url,id,port))}
function decodeSegment(body){let payload;if(body.length>=12&&body.subarray(0,4).toString()==='RIFF'&&body.subarray(8,12).toString()==='WEBP')payload=Buffer.from(body.subarray(12));else if(body.length>=8&&body.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])))payload=Buffer.from(body.subarray(8));else return body;if(!payload.length||payload[0]===71)return payload;const key=Buffer.from([157,42,241,71,179,142,92,112,166,25,228,59,216,98,15,197]);for(let i=0;i<payload.length;i++)payload[i]^=key[i%key.length];return payload}
// A decoded media segment must be MPEG-TS (0x47 sync every 188 bytes) or fragmented MP4.
function isMedia(body){if(body[0]===0x47&&(body.length<=188||body[188]===0x47))return true;const box=body.subarray(4,8).toString('latin1');return ['ftyp','styp','moof','sidx','emsg'].includes(box)}
// Some CDNs wrap segments in other fake image headers; find where the TS stream starts.
function findTs(body){const limit=Math.min(body.length-376,4096);for(let i=1;i<limit;i++)if(body[i]===0x47&&body[i+188]===0x47&&body[i+376]===0x47)return body.subarray(i);return null}
async function handle(req,res){try{const parts=new URL(req.url,'http://127.0.0.1').pathname.split('/').filter(Boolean);if(parts.length<3||parts[0]!=='__flix'){res.writeHead(404).end();return}const data=sessions.get(parts[1]);if(!data){res.writeHead(410).end();return}if(parts[2]==='master.m3u8'&&data.videoUrl&&data.audioUrl){const port=server.address().port,video=proxyUrl(port,parts[1],data.videoUrl),audio=proxyUrl(port,parts[1],data.audioUrl);const body=Buffer.from(`#EXTM3U\n#EXT-X-VERSION:7\n#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",NAME="Default",DEFAULT=YES,AUTOSELECT=YES,URI="${audio}"\n#EXT-X-STREAM-INF:BANDWIDTH=5000000,AUDIO="audio"\n${video}\n`);res.writeHead(200,{'content-type':'application/vnd.apple.mpegurl','content-length':body.length,'access-control-allow-origin':'*','cache-control':'no-store'});res.end(body);return}const target=Buffer.from(parts.slice(2).join('/'),'base64url').toString();const headers={};for(const [k,v]of Object.entries(data.headers||{}))if(['user-agent','referer','origin','cookie','accept','accept-language'].includes(k.toLowerCase())&&v)headers[k]=v;const type=kind(target);let upstream,raw,body;
  // Media segments are validated after decoding; a CDN occasionally answers with something else,
  // so refetch twice and otherwise fail the request (hls.js retries loads, but a parse error is fatal).
  for(let attempt=0;attempt<3;attempt++){
    upstream=await fetch(target,{headers});raw=Buffer.from(await upstream.arrayBuffer());
    if(!upstream.ok){res.writeHead(upstream.status,{'content-type':upstream.headers.get('content-type')||'text/plain'});res.end(raw);return}
    if(type==='m3u8'){body=decodeManifest(raw,data.pk,target,parts[1],server.address().port);break}
    body=decodeSegment(raw);if(isMedia(body))break;
    const ts=findTs(body)||findTs(raw);if(ts){body=ts;break}
    if(type!=='segment'&&!/\.(ts|m4s|mp4|webp|png|jpe?g|gif|ico|js|css|html?)$/i.test(new URL(target).pathname)){body=raw;break}
    body=null;
  }
  if(!body)throw new Error('영상 조각 데이터가 올바르지 않습니다.');res.writeHead(200,{'content-type':type==='m3u8'?'application/vnd.apple.mpegurl':type==='segment'?'video/mp4':upstream.headers.get('content-type')||'application/octet-stream','content-length':body.length,'access-control-allow-origin':'*','cache-control':'no-store','accept-ranges':'none'});res.end(req.method==='HEAD'?undefined:body)}catch(error){const body=Buffer.from(`FLIX_DECODE_FAILED: ${error.message}`);res.writeHead(502,{'content-type':'text/plain; charset=utf-8','content-length':body.length});res.end(body)}}
async function ensureServer(){if(server?.listening)return;server=http.createServer(handle);await new Promise((resolve,reject)=>server.once('error',reject).listen(0,'127.0.0.1',resolve))}
async function createFlixProxyUrl(url,pk,headers={}){await ensureServer();const id=crypto.randomUUID().replaceAll('-','');sessions.set(id,{pk,headers});return proxyUrl(server.address().port,id,url)}
async function createFlixAvProxyUrl(videoUrl,audioUrl,pk,headers={}){await ensureServer();const id=crypto.randomUUID().replaceAll('-','');sessions.set(id,{pk,headers,videoUrl,audioUrl});return `http://127.0.0.1:${server.address().port}/__flix/${id}/master.m3u8`}
function closeFlixProxy(){sessions.clear();server?.close();server=null}

module.exports={createFlixProxyUrl,createFlixAvProxyUrl,closeFlixProxy};
