const fs = require('fs');

// Keep the original HTTP payload separate from FFmpeg's output: an interrupted MP4 remux cannot be appended safely.
async function downloadFile({ url, file, identity = url, headers = {}, signal, progress = () => {}, fetch = globalThis.fetch }) {
  const metadataFile = `${file}.json`;
  let metadata = {};
  try { metadata = JSON.parse(fs.readFileSync(metadataFile, 'utf8')); } catch {}
  let offset = fs.existsSync(file) ? fs.statSync(file).size : 0;
  if (metadata.identity !== identity) offset = 0;
  if (offset && metadata.complete && offset === metadata.received) { progress(offset, offset); return; }
  const validator = metadata.etag && !metadata.etag.startsWith('W/') ? metadata.etag : metadata.modified;
  if (!validator) offset = 0;
  const idle = new AbortController(); let timer;
  const refresh = () => { clearTimeout(timer); timer = setTimeout(() => idle.abort(new DOMException('영상 다운로드 응답 시간이 초과됐습니다.', 'TimeoutError')), 180000); };
  try {
  for (let attempt = 0; attempt < 2; attempt++) {
    signal?.throwIfAborted();
    refresh();
    const response = await fetch(url, { headers: { ...headers, 'Accept-Encoding': 'identity', ...(offset ? { Range: `bytes=${offset}-`, 'If-Range': validator } : {}) },
      signal: signal ? AbortSignal.any([signal, idle.signal]) : idle.signal });
    const range = response.headers.get('content-range')?.match(/^bytes (\d+)-(\d+)\/(\d+)$/);
    const etag = response.headers.get('etag') || '', modified = response.headers.get('last-modified') || '';
    const append = offset > 0 && response.status === 206 && Number(range?.[1]) === offset &&
      (!metadata.etag || !etag || metadata.etag === etag) && (!metadata.modified || !modified || metadata.modified === modified) &&
      (!metadata.total || Number(range?.[3]) === metadata.total);
    if (response.status === 416 || response.status === 206 && !append) {
      await response.body?.cancel(); offset = 0;
      if (attempt === 0) continue;
      throw new Error('다운로드 이어받기 응답 범위가 올바르지 않습니다.');
    }
    if (!response.ok) { await response.body?.cancel(); throw new Error(`영상 다운로드 HTTP ${response.status}`); }
    if (!append) offset = 0; // A server ignoring Range or changing the file must replace the old payload.
    const total = append ? Number(range[3]) : Number(response.headers.get('content-length')) || 0;
    metadata = { identity, etag, modified, total, received: offset, complete: false };
    fs.writeFileSync(metadataFile, JSON.stringify(metadata));
    const fd = fs.openSync(file, append ? 'a' : 'w'); let received = offset;
    progress(received, total);
    try {
      for await (const chunk of response.body) {
        signal?.throwIfAborted();
        refresh();
        const buffer = Buffer.from(chunk); let written = 0;
        while (written < buffer.length) written += fs.writeSync(fd, buffer, written, buffer.length - written);
        received += buffer.length; progress(received, total);
      }
      signal?.throwIfAborted();
      if (total && received !== total) throw new Error('영상 다운로드 연결이 끊겼습니다. 이어서 다시 시도합니다.');
      metadata.received = received; metadata.complete = true;
      fs.writeFileSync(metadataFile, JSON.stringify(metadata));
    } finally { fs.closeSync(fd); }
    return;
  }
  } finally { clearTimeout(timer); }
}

module.exports = { downloadFile };
