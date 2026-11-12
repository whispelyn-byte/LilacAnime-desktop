// Read-only source smoke check (Electron preserves the Korean sites' TLS behavior):
// node node_modules/electron/cli.js tests/catalog-filters.live.cjs
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const cheerio = require('cheerio'), zlib = require('node:zlib');
const electron = process.versions.electron ? require('electron') : null;
const { createCatalogBrowser } = require('../electron/catalog-browser.cjs');
const { createCatalogUpdates } = require('../electron/catalog-updates.cjs');
const source = fs.readFileSync(path.join(__dirname, '../electron/main.cjs'), 'utf8');
const ctx = vm.createContext({ cheerio, zlib, Buffer, URL, URLSearchParams, AbortController, AbortSignal, setTimeout, clearTimeout,
  fetch, LINKKF_UA: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0.0.0 Safari/537.36',
  LINKKF_API: 'https://linkkf1.5imgdarr.top/api', LINKKF_WEB: 'https://linkkf.app', REANIME_WEB: 'https://reanime.cz', REANIME_ID: 'https://reanime.to', reanimeLive: url => String(url || '').replace(/^https?:\/\/(?:www\.)?reanime\.(?:to|cz)(?=[/?#]|$)/i, 'https://reanime.cz'),
  ANIMENOSUB_WEB: 'https://animenosub.to', MIRURO_WEB: 'https://www.miruro.to', MIRURO_KEY: Buffer.from('miruro/catalog'),
  LINKANI_WEB: 'https://linkani.tv', OHLI24_WEB: 'https://ani.ohli24.com', net: electron?.net || { fetch }
});
function add(name, oneLine = false) {
  const match = new RegExp(`^(?:async )?function ${name}\\(`, 'm').exec(source);
  if (!match) throw new Error(`Missing production function: ${name}`);
  const start = match.index, end = oneLine ? source.indexOf('\n', start) : source.indexOf('\n}', start) + 2;
  vm.runInContext(source.slice(start, end), ctx);
}
for (const name of ['linkkfFetch', 'linkkfImage', 'linkkfAnime', 'linkkfFilterTags', 'linkkfFilter', 'providerFetch', 'reanimeItems', 'animenosubList', 'miruroApi', 'miruroItem', 'linkaniFetch', 'linkaniItems', 'ohliFetch', 'ohliPage', 'ohliAnime', 'ohliBoard', 'ohliBrowse']) add(name);
for (const name of ['absoluteUrl', 'miruroText', 'ohliAiring']) add(name, true);
vm.runInContext(source.match(/^const ohliText=.*$/m)[0], ctx);
vm.runInContext(source.match(/^const ohliInfo=.*$/m)[0], ctx);
vm.runInContext("const ohliPath=(...parts)=>`${OHLI24_WEB}/${parts.map(part=>encodeURIComponent(part)).join('/')}`;", ctx);
const browser = createCatalogBrowser({
  reanimeBase: ctx.REANIME_WEB, reanimeFetch: url => ctx.providerFetch(url, { json: true }), reanimeItems: ctx.reanimeItems,
  animenosubBase: ctx.ANIMENOSUB_WEB, animenosubFetch: ctx.providerFetch, animenosubItems: ctx.animenosubList,
  linkkfTags: ctx.linkkfFilterTags, linkkfFilter: ctx.linkkfFilter, miruroApi: liveMiruroApi, miruroItem: ctx.miruroItem,
  linkaniBase: ctx.LINKANI_WEB, linkaniFetch: ctx.linkaniFetch, linkaniItems: ctx.linkaniItems, ohliBrowse: ctx.ohliBrowse, ohliBase: ctx.OHLI24_WEB, ohliPage: ctx.ohliPage, ohliAnime: ctx.ohliAnime,
  updates: createCatalogUpdates({ miruroApi: liveMiruroApi, miruroItem: ctx.miruroItem })
});
async function liveMiruroApi(name, params) {
  try { return await ctx.miruroApi(name, params); } catch (error) { throw new Error(`${name} ${JSON.stringify(params || {}).slice(0, 400)}: ${error.message}`); }
}
(async () => {
  if (electron) await electron.app.whenReady();
  if (process.argv.includes('--remaining-advanced')) {
    const tasks = [
      ['reanime', { genre: 'Fantasy', format: 'TV', year: '2025', status: 'Finished', country: 'JP', tag: 'Magic', audio: 'dub', rating: 'PG-13' }],
      ['reanime', { studio: 'Kyoto Animation', status: 'Finished', sort: 'year' }],
      ['animenosub', { genre: 'action', format: 'tv', year: '2025', studio: 'bones', status: 'completed', sub: 'dub', order: 'title' }]
    ];
    tasks.push(['animenosub', { studio: 'bones', status: 'completed', sub: 'sub', order: 'rating' }]);
    for (const type of ['characters', 'staff']) {
      const facet = await ctx.providerFetch(`https://reanime.to/api/v1/search/facets/${type}?q=${type === 'characters' ? 'Naruto' : 'Miyazaki'}`, { json: true });
      console.log(type, JSON.stringify(facet).slice(0, 500));
      if (typeof facet.values?.[0] === 'string') tasks.push(['reanime', { [type === 'characters' ? 'character' : 'staff']: facet.values[0] }]);
    }
    await Promise.all(tasks.map(async ([provider, request]) => {
      try { const result = await browser.browse(provider, request); console.log(JSON.stringify({ provider, request, count: result.data.length, total: result.total, sample: result.data.slice(0, 2).map(item => ({ title: item.title, year: item.year, status: item.status, subbed: item.subbed, dubbed: item.dubbed })) })); }
      catch(error) { console.log(JSON.stringify({ provider, request, error: error.message })); process.exitCode = 1; }
    })); return;
  }
  if (process.argv.includes('--re-client')) {
    const html = await ctx.providerFetch('https://reanime.to/search');
    const entry = html.match(/import\("([^"\n]*entry_app[^"\n]+)"\)/)?.[1];
    const entryUrl = new URL(entry, 'https://reanime.to/search'), code = await ctx.providerFetch(entryUrl.href);
    const references = [...new Set(code.match(/(?:\.\.\/|\.\/)[^"'`\s]+\.js/g) || [])];
    console.log('RE node refs', references.filter(value => /37|search/i.test(value)));
    for (const ref of references.filter(value => /(?:nodes?_37|\/37\.)/.test(value))) {
      const url = new URL(ref, entryUrl), node = await ctx.providerFetch(url.href);
      if (process.argv.includes('--params')) {
        for (const marker of ['function El(', 'ke=', 'Ea=', 'qr=']) { const at = node.indexOf(marker); console.log(marker, node.slice(at, at + (marker.startsWith('function') ? 2600 : 1000))); }
        continue;
      }
      console.log('Node imports', [...new Set(node.match(/(?:\.\.\/|\.\/)[^"'`\s]+\.js/g) || [])]);
      const all = [node];
      for (const child of [...new Set(node.match(/(?:\.\.\/|\.\/)[^"'`\s]+\.js/g) || [])]) all.push(await ctx.providerFetch(new URL(child, url).href));
      for (const text of all) if (/api\/v1\/search|country_of_origin|audio.*sub/.test(text)) console.log('RE search code', [...text.matchAll(/api\/v1\/search|origin|audio|rating|tags|status/g)].slice(0, 45).map(match => text.slice(Math.max(0, match.index - 100), match.index + 250)));
    } return;
  }
  if (process.argv.includes('--remaining-taxonomy')) {
    await Promise.all([
      (async () => {
        const html = await ctx.providerFetch('https://animenosub.to/anime/'), $ = cheerio.load(html), fields = {};
        $('input[name], select[name]').each((_, node) => {
          const name = $(node).attr('name'); fields[name] ||= [];
          fields[name].push({ value: $(node).attr('value'), label: $(node).parent().text().trim().slice(0, 100), options: $(node).find('option').map((_, el) => ({ value: $(el).attr('value'), label: $(el).text().trim() })).get() });
        });
        console.log('Animenosub fields', JSON.stringify(Object.fromEntries(Object.entries(fields).map(([key, values]) => [key, { count: values.length, samples: values.slice(0, ['genre[]','studio[]','season[]'].includes(key) ? 3 : 20) }]))));
      })(),
      (async () => {
        const root = await ctx.providerFetch('https://reanime.to/api/v1/search?facets=true&limit=0', { json: true });
        console.log('RE facets', JSON.stringify(Object.fromEntries(Object.entries(root.facets || {}).map(([key, value]) => [key, key === 'tags' ? { count: Object.keys(value).length, samples: Object.keys(value).slice(0, 5) } : value]))));
        const html = await ctx.providerFetch('https://reanime.to/search'), $ = cheerio.load(html);
        console.log('RE controls', JSON.stringify($('input,select,button').map((_, node) => ({ tag: node.name, name: $(node).attr('name'), value: $(node).attr('value'), text: $(node).text().trim().slice(0, 120) })).get().slice(0, 70)));
        if (process.argv.includes('--client')) {
          console.log('RE radios', JSON.stringify($('input[name^="radio-"]').map((_, node) => ({ name: $(node).attr('name'), label: $(node).parent().text().trim() })).get()));
          const assets = $('link[rel="modulepreload"]').map((_, node) => new URL($(node).attr('href'), 'https://reanime.to/search').href).get();
          console.log('RE preload', assets); console.log('RE scripts', $('script').map((_, node) => $(node).text().slice(0, 1600)).get());
          await Promise.all(assets.map(async url => {
            const code = await ctx.providerFetch(url);
            if (/api\/v1\/search|radio-origin|radio-audio/.test(code)) console.log('RE implementation', url, [...code.matchAll(/api\/v1\/search|origin|audio|rating|tags/g)].slice(0, 35).map(match => code.slice(Math.max(0, match.index - 120), match.index + 250)));
          }));
        }
      })()
    ]); return;
  }
  if (process.argv.includes('--ohli-weekday')) {
    for (const value of ['월', '월요일']) { const props = await ctx.ohliPage(`https://ani.ohli24.com/${encodeURIComponent('방영중')}?weekday=${encodeURIComponent(value)}`); console.log(JSON.stringify({ value, tabs: props.tabs, sca: props.sca, count: props.items?.length, samples: props.items?.slice(0, 2).map(item => ({ title: item.title, slug: item.slug })) })); } return;
  }
  if (process.argv.includes('--advanced')) {
    const cases = [
      ['ohli24', { format: 'Movie', year: '1990-1999', order: 'title-asc' }],
      ['ohli24', { genre: '액션', year: '2025', status: '종영', order: 'release-desc', offset: 2 }],
      ['ohli24', { genre: '액션', year: '2026', weekday: '목요일' }],
      ['linkani', { weekday: '월', year: '2025', format: 'TV' }],
      ['miruro', { genre: 'Fantasy', format: 'TV', year: '2025', status: 'FINISHED', country: 'JP', source: 'LIGHT_NOVEL', tag: 'Magic', adult: 'false', scoreMin: '70', scoreMax: '100' }],
      ['miruro', { genre: 'Action', format: 'TV', sort: 'updated' }]
    ];
    await Promise.all(cases.map(async ([provider, request]) => {
      try { const result = await browser.browse(provider, request); console.log(JSON.stringify({ provider, request, total: result.total, count: result.data.length, done: result.done, next: result.nextOffset, sample: result.data.slice(0, 2).map(item => ({ title: item.title, year: item.year, type: item.type, status: item.status })) })); }
      catch(error) { console.log(JSON.stringify({ provider, request, error: error.message })); process.exitCode = 1; }
    })); return;
  }
  if (process.argv.includes('--miruro-query')) {
    if (process.argv.includes('--ids')) {
      const first = (await ctx.miruroApi('anime', { sort: '-popularity', limit: 15 })).data[0];
      for (const params of [{ id_in: first.id, genre_all: 'Action', sort: '-popularity', limit: 15 }, { sort: '-updated_at', genre_all: 'Action', limit: 15 }]) {
        try { console.log(JSON.stringify({ params, result: await ctx.miruroApi('anime', params) }).slice(0, 500)); } catch(error) { console.log(JSON.stringify({ params, error: error.message })); }
      }
      const detail = await ctx.miruroApi(`anime/${first.id}`); console.log(JSON.stringify({ detailKeys: Object.keys(detail), genres: detail.genres, tags: detail.tags?.slice(0, 3) })); return;
    }
    await Promise.all([
      { genre_all: 'Action' }, { format: 'TV' }, { genre_all: 'Action', format: 'TV', status: 'FINISHED', season_year: 2025, country_of_origin: 'JP', score_gte: 70 }
    ].map(async filters => { try { const root = await ctx.miruroApi('anime', { ...filters, sort: '-popularity', limit: 15 }); console.log(JSON.stringify({ filters, count: root.data?.length, sample: root.data?.[0] }).slice(0, 2500)); } catch(error) { console.log(JSON.stringify({ filters, error: error.message })); } })); return;
  }
  if (process.argv.includes('--miruro-client')) {
    const html = await ctx.providerFetch('https://www.miruro.to'), $ = cheerio.load(html);
    const urls = $('script[src]').map((_, node) => new URL($(node).attr('src'), 'https://www.miruro.to').href).get();
    console.log('scripts', urls);
    await Promise.all(urls.map(async url => {
      const code = await ctx.providerFetch(url);
      if (url.includes('/assets/index-')) {
        for (const marker of ['hi=[', 'di=[']) { const at = code.indexOf(marker); console.log(marker, code.slice(at, at + 2200)); }
        const at = code.indexOf('hc='); console.log('Filter constants', code.slice(Math.max(0, at - 2500), at + 2000));
        console.log('Metadata calls', [...code.matchAll(/\/metadata|\/meta|`genres`|`tags`|genre_all|dub_language/g)].slice(0, 25).map(match => code.slice(Math.max(0, match.index - 100), match.index + 230)));
      }
      const matches = [...code.matchAll(/genre_in|genres_in|format_in|season_year|genre:|genres:|genre\b|format\b/g)];
      if (matches.length) console.log(JSON.stringify({ url, snippets: matches.slice(0, 35).map(match => code.slice(Math.max(0, match.index - 100), match.index + 200)) }));
    })); return;
  }
  if (process.argv.includes('--ohli-queries')) {
    const requests = [
      '/%EC%99%84%EA%B2%B0?genres%5B0%5D=%EC%95%A1%EC%85%98&years%5B0%5D=2025&sort=release-desc',
      '/?genres%5B0%5D=%EC%95%A1%EC%85%98&years%5B0%5D=2025&sort=rating-desc',
      '/?types%5B0%5D=%EB%B0%A9%EC%98%81%EC%A4%91&genres%5B0%5D=%EC%95%A1%EC%85%98&years%5B0%5D=2026',
      '/%EA%B7%B9%EC%9E%A5%ED%8C%90?years%5B0%5D=1990-1999&sort=title-asc'
    ];
    await Promise.all(requests.map(async route => {
      const props = await ctx.ohliPage(`https://ani.ohli24.com${route}`);
      console.log(JSON.stringify({ route, keys: Object.keys(props).filter(key => !['banner','translations','auth','setting'].includes(key)), board: props.board, total: props.comics?.total, next: props.comics?.next_page_url, options: props.filterOptions ? { genres: props.filterOptions.genres?.length, years: props.filterOptions.years?.length, types: props.filterOptions.types } : null, sample: (props.comics?.data || props.items || []).slice(0, 2).map(item => ({ title: item.title, category: item.category, published_at: item.published_at, info: item.metadata?.info_rows, tags: item.tags_string })) }));
    })); return;
  }
  if (process.argv.includes('--ohli-client')) {
    const html = await ctx.ohliFetch('https://ani.ohli24.com/%EC%99%84%EA%B2%B0'), $ = cheerio.load(html);
    const url = $('script[src]').map((_, node) => $(node).attr('src')).get().find(value => /\/build\/assets\/app-/.test(value));
    const js = await ctx.ohliFetch(url);
    const assets = [...new Set(js.match(/(?:Home|OhliBoard|[^"/]*Filter[^"/]*)-[\w-]+\.js/g) || [])];
    console.log('assets', assets);
    if (!assets.length) { const at = js.indexOf('__name:`NavigationTab`'); console.log('Filter implementation', js.slice(at, at + 6500)); }
    for (const asset of assets.filter(value => /^(Home|OhliBoard)-/.test(value))) {
      const code = await ctx.ohliFetch(new URL(asset, url).href);
      const snippets = [...code.matchAll(/filterOptions|genres|year|sort|order|sca/g)].map(match => code.slice(Math.max(0, match.index - 100), match.index + 230));
      console.log(asset, JSON.stringify(snippets.slice(0, 60)));
      console.log('imports', code.match(/(?:from|import)\(?["']([^"']+)["']/g));
    } return;
  }
  if (process.argv.includes('--ohli-taxonomy')) {
    await Promise.all(['방영중', '완결', '극장판'].map(async board => {
      const html = await ctx.ohliFetch(`https://ani.ohli24.com/${encodeURIComponent(board)}`), $ = cheerio.load(html);
      const json = html.match(/<script data-page="app" type="application\/json">([\s\S]*?)<\/script>/)?.[1], data = json ? JSON.parse(json) : {};
      console.log(JSON.stringify({ board, component: data.component, keys: Object.keys(data.props || {}), options: data.props?.filterOptions, scopeOptions: data.props?.scopeOptions, controls: $('form input,form select').map((_, node) => ({ tag: node.name, name: $(node).attr('name'), value: $(node).attr('value'), options: $(node).find('option').map((_, item) => ({ value: $(item).attr('value'), text: $(item).text() })).get() })).get(), scripts: $('script[src]').map((_, node) => $(node).attr('src')).get() }));
    })); return;
  }
  if (process.argv.includes('--linkkf-connect')) {
    const url = 'https://linkkf1.5imgdarr.top/api/link/api.php?taxonomy=anigenres&limit=200';
    await Promise.all([['node', fetch], ['electron', ctx.net.fetch]].map(async ([name, get]) => {
      try { const response = await get(url, { signal: AbortSignal.timeout(10000), headers: { 'User-Agent': ctx.LINKKF_UA, Referer: 'https://linkkf.app/' } }); console.log(name, response.status, (await response.text()).slice(0, 120)); }
      catch (error) { console.log(name, error.message, error.cause?.code || ''); }
    })); return;
  }
  if (process.argv.includes('--taxonomy')) {
    const html = await ctx.linkaniFetch('https://linkani.tv/list/2/'), $ = cheerio.load(html);
    console.log('Linkani menu:', JSON.stringify($('a[href*="/list/2/"]').map((_, el) => ({ name: $(el).text().trim(), href: $(el).attr('href') })).get().slice(0, 90)));
    console.log('Linkani first card:', $('.vod-item').first().html());
    for (const taxonomy of ['anime-seasontype', 'anigenres', 'anime-seasonys']) {
      try { const result = await ctx.linkkfFetch(`https://linkkf1.5imgdarr.top/api/link/api.php?taxonomy=${taxonomy}&limit=200&orderby=name&order=ASC`, 8000); console.log('Linkkf taxonomy:', taxonomy, JSON.stringify(result).slice(0, 600)); }
      catch (error) { console.log('Linkkf taxonomy error:', taxonomy, error.message); }
    }
    return;
  }
  if (process.argv.includes('--routes')) {
    await Promise.all(['lang/Movie/', 'class/Action/year/2025/lang/Movie/', 'class/Slice+of+Life/year/2025/lang/TV/', 'year/2025/lang/TV/page/2/'].map(async route => {
      const html = await ctx.linkaniFetch(`https://linkani.tv/list/2/${route}`), $ = cheerio.load(html);
      console.log(JSON.stringify({ route, heading: $('h1').text().trim(), count: $('.vod-item').length, first: $('.vod-item-title').first().text().trim(), next: $('a').filter((_, el) => $(el).text().trim() === '→').attr('href') }));
    })); return;
  }
  await Promise.all(['reanime', 'animenosub', 'miruro', 'linkkf', 'linkani', 'ohli24'].map(async provider => {
    try {
      const facets = await browser.facets(provider);
      const request = { sort: facets.sorts[0] };
      if (facets.genres.length) request.genre = facets.genres.find(item => /action|액션/i.test(item.name + item.value))?.value || facets.genres[0].value;
      if (facets.formats.length) request.format = facets.formats.find(item => /^(TV|tv)$/.test(item.value))?.value || facets.formats[0].value;
      if (facets.year) request.year = facets.yearOptions.find(item => /2025/.test(item.name))?.value || (facets.yearOptions.length ? facets.yearOptions[0].value : '2025');
      if (facets.season) request.season = facets.seasons ? ['WINTER', 'SPRING', 'SUMMER', 'FALL'].find(value => facets.seasons.includes(`${value.toLowerCase()}-${request.year}`)) : 'WINTER';
      const first = await browser.browse(provider, request);
      for (const item of first.data) {
        if (['reanime', 'miruro'].includes(provider)) {
          if (request.year && String(item.year) !== request.year) throw new Error('Returned an item outside the selected year');
          if (request.season && item.season !== request.season) throw new Error('Returned an item outside the selected quarter');
          if (request.format && item.type !== request.format) throw new Error('Returned an item outside the selected format');
          if (provider === 'reanime' && request.genre && !item.genres.some(genre => genre.name === request.genre)) throw new Error('Returned an item outside the selected genre');
        }
      }
      console.log(JSON.stringify({ provider, facets: { genres: facets.genres.length, formats: facets.formats, year: facets.year, season: facets.season }, request, count: first.data.length, total: first.total, nextOffset: first.nextOffset, done: first.done, samples: first.data.slice(0, 3).map(item => ({ title: item.title, type: item.type, year: item.year, season: item.season, genres: item.genres })) }));
    } catch (error) { console.log(JSON.stringify({ provider, error: error.message, cause: error.cause?.code })); process.exitCode = 1; }
  }));
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => { if (electron) electron.app.exit(process.exitCode || 0); });
