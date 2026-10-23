const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const source = fs.readFileSync(path.resolve(__dirname, '../electron/main.cjs'), 'utf8');
const start = source.indexOf('function isAdMedia('), end = source.indexOf('\nconst resolverHooks=', start);
const { isAdMedia } = vm.runInNewContext(`${source.slice(start, end)};({isAdMedia})`, { URL, String });

test('a stream whose token holds the letters "ad" is not taken for an ad', () => {
  for (const url of [
    'https://s1-s501740.97bf1.com/hls/if85L89q3FmegJSQiVb0NVZoqb5YZBFK/master.m3u8?token=a87cad4221cd488b3b36d4b15fa19782-1792738956',
    'https://s14-s1001604.97bf1.com/hls/DimsUI9tbUEVrQ9DMDHqUY4c8aV4JkR5/index_1280x720.m3u8?token=b0b405ba9191bbb091e8-f707153efc8e',
    'https://fetch9.flixcloud.cc/_v7/641075ac-375c-4bb4-af80-6e59493e7f25/master.m3u8?token=eyJadmin',
    'https://cdn.example.com/uploads/load/headers/episode.mp4',
  ]) assert.equal(isAdMedia(url), false, url);
});
test('ad videos are still left out', () => {
  for (const url of [
    'https://ad.example.com/preroll.mp4',
    'https://cdn.example.com/ads/preroll.m3u8',
    'https://example.com/adserver/clip.mp4',
    'https://video.example.com/advert_15s.mp4',
    'https://s.magsrv.com/v.mp4',
    'https://cdn.example.com/x.mp4?src=runative',
  ]) assert.equal(isAdMedia(url), true, url);
});
