// Korean spellings handed to the translators with each subtitle: character names (AniList romaji turned into Hangul
// by the usual Korean fan spelling) and set phrases a small model gets wrong (いただきます is not 감사합니다). The local
// model is given only the entries found in the line it translates (HY-MT's terminology prompt), Gemini the names.

// Hepburn syllables, longest first when read. Korean fan spelling: つ 츠, し 시, ち 치, ふ 후, じ 지, ず 즈.
const SYLLABLES = {
  a: '아', i: '이', u: '우', e: '에', o: '오',
  ka: '카', ki: '키', ku: '쿠', ke: '케', ko: '코', kya: '캬', kyu: '큐', kyo: '쿄',
  ga: '가', gi: '기', gu: '구', ge: '게', go: '고', gya: '갸', gyu: '규', gyo: '교',
  sa: '사', shi: '시', si: '시', su: '스', se: '세', so: '소', sha: '샤', shu: '슈', sho: '쇼', she: '셰',
  za: '자', ji: '지', zi: '지', zu: '즈', ze: '제', zo: '조', ja: '자', ju: '주', jo: '조', je: '제',
  ta: '타', chi: '치', ti: '티', tsu: '츠', tu: '츠', te: '테', to: '토', cha: '차', chu: '추', cho: '초', che: '체',
  da: '다', di: '디', du: '두', dzu: '즈', de: '데', do: '도',
  na: '나', ni: '니', nu: '누', ne: '네', no: '노', nya: '냐', nyu: '뉴', nyo: '뇨',
  ha: '하', hi: '히', fu: '후', hu: '후', he: '헤', ho: '호', hya: '햐', hyu: '휴', hyo: '효', fa: '파', fi: '피', fe: '페', fo: '포',
  ba: '바', bi: '비', bu: '부', be: '베', bo: '보', bya: '뱌', byu: '뷰', byo: '뵤',
  pa: '파', pi: '피', pu: '푸', pe: '페', po: '포', pya: '퍄', pyu: '퓨', pyo: '표',
  ma: '마', mi: '미', mu: '무', me: '메', mo: '모', mya: '먀', myu: '뮤', myo: '묘',
  ya: '야', yu: '유', yo: '요',
  ra: '라', ri: '리', ru: '루', re: '레', ro: '로', rya: '랴', ryu: '류', ryo: '료',
  wa: '와', wo: '오', wi: '위', we: '웨', va: '바', vi: '비', vu: '부', ve: '베', vo: '보'
};
// Adds a final consonant (ㄴ = 4, ㅅ = 19) to the last syllable.
const withFinal = (text, final) => { const code = text.charCodeAt(text.length - 1) - 0xac00; return code >= 0 && code < 11172 && code % 28 === 0 ? text.slice(0, -1) + String.fromCharCode(0xac00 + code + final) : text; };

// One romaji word in Hangul, or '' when it does not read as Japanese (Lelouch, Emilia's "l"...).
function romajiWord(word) {
  let rest = word.toLowerCase().normalize('NFD').replace(/[̄̂]/g, '').replace(/[^a-z']/g, '')
    .replace(/ou(?![aiueo])/g, 'o').replace(/uu/g, 'u').replace(/oo/g, 'o');
  let out = '';
  while (rest) {
    if (rest[0] === "'") { rest = rest.slice(1); continue; }
    // ん: n (or m before b/p/m) not followed by a vowel or y.
    if (/^n(?![aiueoy])/.test(rest) || /^m(?=[bpm])/.test(rest)) { if (!out) return ''; out = withFinal(out, 4); rest = rest.slice(1); continue; }
    // っ: a doubled consonant (tch as well).
    if (/^([kgsztdhbpcfjmr])\1/.test(rest) || rest.startsWith('tch')) { if (!out) return ''; out = withFinal(out, 19); rest = rest.slice(1); continue; }
    const key = [3, 2, 1].map(size => rest.slice(0, size)).find(part => SYLLABLES[part]);
    if (!key) return '';
    out += SYLLABLES[key]; rest = rest.slice(key.length);
  }
  return out;
}
const romaji = name => { const words = String(name || '').trim().split(/[\s-]+/).filter(Boolean), parts = words.map(romajiWord); return parts.length && parts.every(Boolean) ? parts.join(' ') : ''; };

const KANA = /[぀-ヿ]/;
// The native name cut into family and given name: at a space or dot, where kanji turn into kana (白河ことり), or for an
// all-kanji name in proportion to the romaji lengths (椎名真昼: Shiina / Mahiru -> 2 + 2, 藤宮周: Fujimiya / Amane -> 2 + 1).
function splitNative(native, last, first) {
  const parts = native.split(/[\s・･=＝]+/).filter(Boolean);
  if (parts.length === 2) return parts;
  if (parts.length !== 1 || native.length < 2) return null;
  const change = [...native].findIndex((char, index) => index && KANA.test(char) !== KANA.test(native[index - 1]));
  if (change > 0) return [native.slice(0, change), native.slice(change)];
  if (KANA.test(native)) return null;
  const cut = Math.min(native.length - 1, Math.max(1, Math.round(native.length * last.length / (last.length + first.length))));
  return [native.slice(0, cut), native.slice(cut)];
}

// characters: [{name, native, first, last}] from AniList (first/last in romaji). Returns [{ja, ko}].
function characterTerms(characters = []) {
  const terms = [];
  for (const character of characters) {
    const native = String(character.native || '').trim(), first = String(character.first || '').trim(), last = String(character.last || '').trim();
    if (!native) continue;
    const firstKo = romaji(first), lastKo = romaji(last);
    if (first && last && firstKo && lastKo) {
      terms.push({ ja: native, ko: `${lastKo} ${firstKo}` });
      const split = splitNative(native, last, first);
      if (split) terms.push({ ja: split[0], ko: lastKo }, { ja: split[1], ko: firstKo });
    } else if (!last && firstKo) terms.push({ ja: native, ko: firstKo });
  }
  // One spelling per Japanese name (the first, from the most important character).
  return terms.filter((term, index) => term.ja && terms.findIndex(other => other.ja === term.ja) === index);
}

// Set phrases. greeting: only as a phrase of its own (ただいま is also "right now" inside a sentence).
const PHRASES = [
  ['いただきます', '잘 먹겠습니다', true], ['ごちそうさまでした', '잘 먹었습니다', true], ['ごちそうさま', '잘 먹었어', true],
  ['ただいま', '다녀왔어', true], ['おかえりなさい', '어서 와', true], ['おかえり', '어서 와', true],
  ['いってきます', '다녀올게', true], ['行ってきます', '다녀올게', true], ['いってらっしゃい', '잘 다녀와', true], ['行ってらっしゃい', '잘 다녀와', true],
  ['おやすみなさい', '안녕히 주무세요', true], ['おやすみ', '잘 자', true],
  ['お疲れ様でした', '수고하셨습니다', false], ['お疲れさまでした', '수고하셨습니다', false], ['お疲れ様です', '수고하십니다', false], ['お疲れさまです', '수고하십니다', false],
  ['よろしくお願いします', '잘 부탁드립니다', false], ['よろしくお願いいたします', '잘 부탁드립니다', false],
  ['先輩', '선배', false], ['先生', '선생님', false], ['マジで', '진짜', false]
].map(([ja, ko, greeting]) => ({ ja, ko, greeting }));

const EDGE = /[\s、。，．！？!?…‥「」『』（）()〜~ー・]/;
// A one-character name (周) only counts with a name around it: at a phrase edge or before an honorific.
const AFTER_NAME = /[さくちく様殿君氏先っ]/;
function found(line, term) {
  for (let at = line.indexOf(term.ja); at >= 0; at = line.indexOf(term.ja, at + 1)) {
    const before = at ? line[at - 1] : '', after = line[at + term.ja.length] || '';
    if (term.greeting) { if ((!before || EDGE.test(before)) && (!after || EDGE.test(after))) return true; continue; }
    if (term.ja.length > 1) return true;
    if ((!before || EDGE.test(before)) && (!after || EDGE.test(after) || AFTER_NAME.test(after))) return true;
  }
  return false;
}
// The entries that appear in a line; one found inside a longer one (お疲れ in お疲れ様です) is left out.
function termsFor(line, terms) {
  const hits = [...terms, ...PHRASES].filter(term => found(line, term));
  return hits.filter(term => !hits.some(other => other !== term && other.ja.length > term.ja.length && other.ja.includes(term.ja)));
}

// Words for an older brother or sister, which Korean says by the speaker's sex: 형 / 누나 from a boy, 오빠 / 언니 from a
// girl. Small and large local models alike took Sota's お姉ちゃん as 언니 though told the rule and the cast's sexes, so a
// line with a speaker tag of the cast ((創太), (堀 創太)) gets the Korean word itself as a term. Lines without a tag are
// left to the model: the line before is no guide (Kyoko quoting Sota's お兄ちゃん is still 형).
const SIBLINGS = [
  ...['お兄ちゃん', 'おにいちゃん', 'おにーちゃん', 'お兄さん', 'おにいさん', '兄ちゃん', '兄さん', '兄貴'].map(ja => ({ ja, male: '형', female: '오빠' })),
  ...['お姉ちゃん', 'おねえちゃん', 'おねーちゃん', 'おね～ちゃん', 'お姉さん', 'おねえさん', '姉ちゃん', '姉さん', '姉貴'].map(ja => ({ ja, male: '누나', female: '언니' }))
];
// The cast member a tag names, by full name or a part of it that only one of them has (堀 is both Kyoko and Sota).
function castMember(tag, characters) {
  const name = tag.replace(/\([^)]*\)|（[^）]*）/g, '').replace(/[\s　]/g, '');
  if (!name || /[･・、,]/.test(name)) return null;
  const parts = character => { const native = String(character.native || '').replace(/[\s　]/g, ''); const split = splitNative(String(character.native || '').trim(), String(character.last || ''), String(character.first || '')); return [native, ...(split || [])]; };
  const full = characters.find(character => parts(character)[0] === name);
  if (full) return full;
  const matches = characters.filter(character => parts(character).slice(1).includes(name));
  return matches.length === 1 ? matches[0] : null;
}
// Terms for the sibling words in a subtitle (a cue's lines; a tag starts a speaker's line and holds for the lines after
// it in the cue), for the speaker's sex from AniList.
function speakerTerms(text, characters = []) {
  const terms = []; let speaker = null;
  for (const line of String(text).split('\n')) {
    const tag = line.match(/^\s*[（(]((?:[^（）()]|\([^)]*\))+)[）)]/);
    if (tag) speaker = castMember(tag[1], characters);
    const sex = /^(male|female)$/i.test(speaker?.gender || '') ? speaker.gender.toLowerCase() : '';
    if (!sex) continue;
    for (const word of SIBLINGS) if (line.includes(word.ja) && !terms.some(term => term.ja === word.ja)) terms.push({ ja: word.ja, ko: word[sex] });
  }
  return terms.filter(term => !terms.some(other => other !== term && other.ja.length > term.ja.length && other.ja.includes(term.ja)));
}

module.exports = { romaji, characterTerms, termsFor, speakerTerms };
