// 급식 어때? — 커뮤니티 리뷰 백엔드 (Railway 배포)
// 정적 파일(index.html, data/*.json) + /api/reviews 엔드포인트
const express = require('express');
const cors = require('cors');
const fs = require('fs').promises;
const path = require('path');
const { randomUUID } = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;
const DATA_DIR = path.join(__dirname, 'data');
const REVIEWS_FILE = path.join(DATA_DIR, 'community-reviews.json');

app.use(cors());
app.use(express.json({ limit: '64kb' }));

// ────────────────────────────────────────
// 리뷰 데이터 (JSON 파일 + 인메모리 캐시)
// ────────────────────────────────────────
let cache = null;
let saving = null;

async function loadReviews() {
  if (cache) return cache;
  try {
    const data = await fs.readFile(REVIEWS_FILE, 'utf8');
    cache = JSON.parse(data);
  } catch {
    cache = {};
  }
  return cache;
}

async function saveReviews() {
  // 동시 저장 직렬화
  if (saving) await saving;
  saving = (async () => {
    await fs.mkdir(DATA_DIR, { recursive: true });
    await fs.writeFile(REVIEWS_FILE, JSON.stringify(cache));
  })();
  await saving;
  saving = null;
}

// ────────────────────────────────────────
// 헬퍼
// ────────────────────────────────────────
function sanitize(s, max = 500) {
  return String(s || '').slice(0, max);
}

function clientReview(r) {
  // authorToken은 클라이언트로 노출하지 않음
  const { authorToken, ...rest } = r;
  return rest;
}

function dateLabel(iso) {
  const t = new Date(iso);
  const diff = (Date.now() - t.getTime()) / 1000;
  if (diff < 60) return '방금 전';
  if (diff < 3600) return Math.floor(diff/60) + '분 전';
  if (diff < 86400) return Math.floor(diff/3600) + '시간 전';
  return Math.floor(diff/86400) + '일 전';
}

// ────────────────────────────────────────
// API
// ────────────────────────────────────────

// GET /api/reviews/:schoolCode  — 리뷰 목록 + 사용자 본인 글 표시
app.get('/api/reviews/:schoolCode', async (req, res) => {
  const all = await loadReviews();
  const list = all[req.params.schoolCode] || [];
  const myToken = req.query.token || '';
  const out = list.map(r => ({
    ...clientReview(r),
    isMine: !!myToken && r.authorToken === myToken,
    date: dateLabel(r.createdAt),
  }));
  res.json(out);
});

// POST /api/reviews/:schoolCode  — 새 리뷰
app.post('/api/reviews/:schoolCode', async (req, res) => {
  const { who, role, stars, body, tag, authorToken } = req.body;
  if (!who || !body || stars == null) {
    return res.status(400).json({ error: '필수 필드 누락' });
  }
  if (!authorToken || authorToken.length < 8) {
    return res.status(400).json({ error: 'authorToken 필수' });
  }
  const all = await loadReviews();
  const code = req.params.schoolCode;
  if (!all[code]) all[code] = [];
  const review = {
    id: 'r-' + randomUUID(),
    who: sanitize(who, 30),
    role: ['학부모','학생'].includes(role) ? role : '학부모',
    stars: Math.max(1, Math.min(5, parseInt(stars) || 5)),
    body: sanitize(body, 500),
    tag: sanitize(tag || '직접작성', 20),
    likes: 0,
    helpful: 0,
    createdAt: new Date().toISOString(),
    authorToken,
  };
  all[code].unshift(review);
  // 학교당 최대 500개
  if (all[code].length > 500) all[code] = all[code].slice(0, 500);
  await saveReviews();
  res.json({ ...clientReview(review), isMine: true, date: '방금 전' });
});

// PATCH /api/reviews/:schoolCode/:id  — 본인 글 수정
app.patch('/api/reviews/:schoolCode/:id', async (req, res) => {
  const { stars, body, who, role, authorToken } = req.body;
  if (!authorToken) return res.status(400).json({ error: 'authorToken 필수' });
  const all = await loadReviews();
  const list = all[req.params.schoolCode] || [];
  const idx = list.findIndex(r => r.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: '리뷰 없음' });
  if (list[idx].authorToken !== authorToken) {
    return res.status(403).json({ error: '본인 글만 수정 가능' });
  }
  if (stars != null) list[idx].stars = Math.max(1, Math.min(5, parseInt(stars) || list[idx].stars));
  if (body) list[idx].body = sanitize(body, 500);
  if (who) list[idx].who = sanitize(who, 30);
  if (role && ['학부모','학생'].includes(role)) list[idx].role = role;
  list[idx].edited = true;
  list[idx].editedAt = new Date().toISOString();
  await saveReviews();
  res.json({ ...clientReview(list[idx]), isMine: true, date: dateLabel(list[idx].createdAt) });
});

// DELETE /api/reviews/:schoolCode/:id  — 본인 글 삭제
app.delete('/api/reviews/:schoolCode/:id', async (req, res) => {
  const token = req.query.token || (req.body || {}).authorToken;
  if (!token) return res.status(400).json({ error: 'token 필수' });
  const all = await loadReviews();
  const list = all[req.params.schoolCode] || [];
  const idx = list.findIndex(r => r.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: '리뷰 없음' });
  if (list[idx].authorToken !== token) {
    return res.status(403).json({ error: '본인 글만 삭제 가능' });
  }
  list.splice(idx, 1);
  await saveReviews();
  res.json({ ok: true });
});

// ─────────────────────────────────────────────
// 급식 좋아요 — 학교별 누적 카운트 + 사용자 토글
// data/community-likes.json
// 구조: { schoolCode: { count: N, users: [token1, ...] } }
// ─────────────────────────────────────────────
const LIKES_FILE = path.join(DATA_DIR, 'community-likes.json');
let likesCache = null;
let likesSaving = null;

async function loadLikes() {
  if (likesCache) return likesCache;
  try {
    const data = await fs.readFile(LIKES_FILE, 'utf8');
    likesCache = JSON.parse(data);
  } catch {
    likesCache = {};
  }
  return likesCache;
}
async function saveLikes() {
  if (likesSaving) await likesSaving;
  likesSaving = (async () => {
    await fs.mkdir(DATA_DIR, { recursive: true });
    await fs.writeFile(LIKES_FILE, JSON.stringify(likesCache));
  })();
  await likesSaving;
  likesSaving = null;
}

app.get('/api/likes/:schoolCode', async (req, res) => {
  const all = await loadLikes();
  const data = all[req.params.schoolCode] || { count: 0, users: [] };
  const myToken = req.query.token || '';
  res.json({
    count: data.count,
    hasLiked: !!myToken && data.users.includes(myToken),
  });
});

app.post('/api/likes/:schoolCode', async (req, res) => {
  const { authorToken } = req.body || {};
  if (!authorToken || authorToken.length < 4) {
    return res.status(400).json({ error: 'authorToken 필수' });
  }
  const all = await loadLikes();
  const code = req.params.schoolCode;
  if (!all[code]) all[code] = { count: 0, users: [] };
  const data = all[code];
  const idx = data.users.indexOf(authorToken);
  let hasLiked;
  if (idx >= 0) {
    data.users.splice(idx, 1);
    data.count = Math.max(0, data.count - 1);
    hasLiked = false;
  } else {
    data.users.push(authorToken);
    data.count++;
    hasLiked = true;
  }
  await saveLikes();
  res.json({ count: data.count, hasLiked });
});

// 헬스 체크
app.get('/api/health', (req, res) => res.json({ ok: true, time: new Date().toISOString() }));

// ─────────────────────────────────────────────
// 학교 상세 정보 프록시 (CORS 우회)
// 학교알리미 → NEIS schoolInfo → NEIS classInfo 추정 순으로 시도
// ─────────────────────────────────────────────
const NEIS_KEY = 'dd9c4f1cf6da4ffb92fe6101e188c14e';
// 학교알리미 OpenAPI (2026 갱신 — 계정 8602155)
const SCHOOLINFO_KEY = 'c9dea6e5158a4b76a26d7e1db1a9beb1';
const SCHOOLINFO_BASE = 'https://www.schoolinfo.go.kr/openApi.do';
const schoolExtraCache = {};

async function fetchWithTimeout(url, timeoutMs = 10000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(url, { signal: ctrl.signal, headers: { 'User-Agent': 'kmeal-app/1.7' } });
    clearTimeout(t);
    return r;
  } catch (e) {
    clearTimeout(t);
    return null;
  }
}

app.get('/api/school-extra/:office/:code', async (req, res) => {
  const { office, code } = req.params;
  const cacheKey = `${office}:${code}`;

  // 메모리 캐시 24시간
  if (schoolExtraCache[cacheKey] && Date.now() - schoolExtraCache[cacheKey].t < 24 * 3600 * 1000) {
    return res.json(schoolExtraCache[cacheKey].v);
  }

  const result = { source: 'unknown' };

  // 1) NEIS schoolInfo — 학교 기본정보 (전화·홈페이지·학교급)
  try {
    const url = `https://open.neis.go.kr/hub/schoolInfo?KEY=${NEIS_KEY}&Type=json&pIndex=1&pSize=1&ATPT_OFCDC_SC_CODE=${encodeURIComponent(office)}&SD_SCHUL_CODE=${encodeURIComponent(code)}`;
    const r = await fetchWithTimeout(url, 10000);
    if (r && r.ok) {
      const j = await r.json();
      const row = j?.schoolInfo?.[1]?.row?.[0];
      if (row) {
        result.tel = row.ORG_TELNO || null;
        result.homepage = row.HMPG_ADRES || null;
        result.kind = row.SCHUL_KND_SC_NM || null;
        result.foundedYmd = row.FOND_YMD || null;
        result.coed = row.COEDU_SC_NM || null;
        result.addr = row.ORG_RDNMA || null;
      }
    }
  } catch (e) { console.warn('[school-extra] NEIS schoolInfo 실패:', e.message); }

  // 2) 학교알리미 OpenAPI — 정확한 apiType 코드 + sidoCode/sggCode
  //    apiType=34 (급식 실시 현황) → HAKSAENGSU_TOT · MLSV_STDNT_FGR
  //    apiType=22 (직위별 교원 현황) → COL_S (총계)
  // 호출 방식: sidoCode + sggCode 로 전체 학교 list 받고 SCHUL_NM/SCHUL_CODE 로 매칭
  if (result.kind && result.addr) {
    const schulKnd = result.kind.includes('초') ? '02' : result.kind.includes('중') ? '03' : result.kind.includes('고') ? '04' : '02';
    // 주소에서 시도·시군구 추출
    const sggMap = (() => {
      try {
        const fs2 = require('fs');
        return JSON.parse(fs2.readFileSync(path.join(__dirname, 'data', 'sgg_codes.json'), 'utf8'));
      } catch { return {}; }
    })();
    const addr = result.addr;
    let sidoName = null, sggName = null, sidoCode = null, sggCode = null;
    for (const [sido, info] of Object.entries(sggMap)) {
      if (addr.includes(sido) || addr.startsWith(sido.slice(0, 2))) {
        sidoName = sido;
        sidoCode = info.code;
        for (const [sgg, sCode] of Object.entries(info.districts || {})) {
          if (addr.includes(sgg)) { sggName = sgg; sggCode = sCode; break; }
        }
        break;
      }
    }
    console.log('[school-extra] 주소 → 시도/시군구:', { addr, sidoName, sidoCode, sggName, sggCode });

    if (sidoCode && sggCode) {
      const yearNow = new Date().getFullYear();
      const years = [yearNow - 1, yearNow, yearNow - 2];

      // helper — sidoCode+sggCode 호출, list 응답 받아 학교명으로 매칭
      async function callSchoolInfoList(apiType, year) {
        const url = `${SCHOOLINFO_BASE}?apiKey=${SCHOOLINFO_KEY}&apiType=${apiType}&pbanYr=${year}&schulKndCode=${schulKnd}&sidoCode=${sidoCode}&sggCode=${sggCode}`;
        try {
          const r = await fetchWithTimeout(url, 12000);
          if (!r || !r.ok) return null;
          const txt = await r.text();
          if (!txt || txt.length < 30) return null;
          let j;
          try { j = JSON.parse(txt); } catch { return null; }
          if (j.resultCode === 'fail') return null;
          const list = j.list || j.items || [];
          // 학교명/학교코드로 매칭 (NEIS의 SD_SCHUL_CODE 와 학교알리미의 SCHUL_CODE 가 다를 수 있어 학교명 우선)
          const schoolName = result.kind && result.addr ? (result.schoolName || null) : null;
          // result에 schoolName이 없으면 NEIS에서 받은 이름을 사용
          return list;
        } catch { return null; }
      }

      // schoolName 확보 (NEIS에서 받은 학교명)
      let myName = result.schoolName;
      if (!myName) {
        try {
          const url = `https://open.neis.go.kr/hub/schoolInfo?KEY=${NEIS_KEY}&Type=json&pIndex=1&pSize=1&ATPT_OFCDC_SC_CODE=${encodeURIComponent(office)}&SD_SCHUL_CODE=${encodeURIComponent(code)}`;
          const r = await fetchWithTimeout(url, 8000);
          if (r && r.ok) {
            const j = await r.json();
            myName = j?.schoolInfo?.[1]?.row?.[0]?.SCHUL_NM || null;
          }
        } catch {}
      }

      // 학교명 정규화 (공백·괄호 제거)
      const normalize = (s) => String(s || '').replace(/\s+/g,'').replace(/[()（）]/g,'');
      const myKey = normalize(myName);

      // ━ apiType=34: 급식 실시 현황
      for (const year of years) {
        const list = await callSchoolInfoList('34', year);
        if (!list) continue;
        const my = list.find(x => normalize(x.SCHUL_NM) === myKey)
                || list.find(x => normalize(x.SCHUL_NM).includes(myKey) || myKey.includes(normalize(x.SCHUL_NM)));
        if (my && my.HAKSAENGSU_TOT) {
          result.students = parseInt(String(my.HAKSAENGSU_TOT).replace(/,/g,''), 10) || null;
          result.mealStudents = parseInt(String(my.MLSV_STDNT_FGR || 0).replace(/,/g,''), 10) || null;
          result.mealRate = parseFloat(my.KS_RATE) || null;
          result.nutritionists = parseInt(my.NTRST_FGR || 0, 10) || null;
          result.cooks = parseInt(my.COOK_FGR || 0, 10) || null;
          result.cookHelpers = parseInt(my.COOAS_FGR || 0, 10) || null;
          result.source = 'schoolinfo';
          console.log('[school-extra] ✓ 학교알리미(34=급식) 매칭:', { school: my.SCHUL_NM, year, students: result.students });
          break;
        }
      }

      // ━ apiType=22: 직위별 교원 현황
      for (const year of years) {
        const list = await callSchoolInfoList('22', year);
        if (!list) continue;
        const my = list.find(x => normalize(x.SCHUL_NM) === myKey)
                || list.find(x => normalize(x.SCHUL_NM).includes(myKey) || myKey.includes(normalize(x.SCHUL_NM)));
        if (my && (my.COL_S || my.COL_SM)) {
          const active = (parseInt(my.COL_SM || 0,10) || 0) + (parseInt(my.COL_SW || 0,10) || 0);
          const all = parseInt(String(my.COL_S || 0).replace(/,/g,''), 10) || 0;
          result.teachers = active || all || null;
          if (result.source !== 'schoolinfo') result.source = 'schoolinfo';
          console.log('[school-extra] ✓ 학교알리미(22=교원) 매칭:', { school: my.SCHUL_NM, year, teachers: result.teachers });
          break;
        }
      }
    } else {
      console.warn('[school-extra] 시도/시군구 코드 매핑 실패 — 주소:', addr);
    }
  }

  // 3) 학교알리미 실패 시 NEIS classInfo로 학급 수 기반 추정
  if (!result.students || !result.teachers) {
    try {
      const year = new Date().getFullYear();
      const url = `https://open.neis.go.kr/hub/classInfo?KEY=${NEIS_KEY}&Type=json&pIndex=1&pSize=200&ATPT_OFCDC_SC_CODE=${encodeURIComponent(office)}&SD_SCHUL_CODE=${encodeURIComponent(code)}&AY=${year}`;
      const r = await fetchWithTimeout(url, 10000);
      if (r && r.ok) {
        const j = await r.json();
        const rows = j?.classInfo?.[1]?.row;
        if (rows && rows.length) {
          const classCount = rows.length;
          const kind = result.kind || '';
          const avgPerClass = kind.includes('초') ? 22 : kind.includes('중') ? 26 : 28;
          if (!result.students) result.students = Math.round(classCount * avgPerClass);
          if (!result.teachers) result.teachers = Math.round(classCount * 1.4) + (classCount > 30 ? 8 : classCount > 15 ? 6 : 4);
          result.classCount = classCount;
          if (result.source === 'unknown') result.source = 'neis-classInfo';
        }
      }
    } catch (e) { console.warn('[school-extra] classInfo 실패:', e.message); }
  }

  schoolExtraCache[cacheKey] = { t: Date.now(), v: result };
  res.json(result);
});

// ─────────────────────────────────────────────
// 진단 엔드포인트 — 학교알리미 응답 형식 확인용
// 사용: GET /api/school-extra-debug/B10/7000123
// ─────────────────────────────────────────────
app.get('/api/school-extra-debug/:office/:code', async (req, res) => {
  const { office, code } = req.params;
  const year = new Date().getFullYear();
  const attempts = [];

  // NEIS schoolInfo 먼저로 학교급 알아내기
  let kind = null;
  try {
    const url = `https://open.neis.go.kr/hub/schoolInfo?KEY=${NEIS_KEY}&Type=json&pIndex=1&pSize=1&ATPT_OFCDC_SC_CODE=${office}&SD_SCHUL_CODE=${code}`;
    const r = await fetchWithTimeout(url, 10000);
    if (r && r.ok) {
      const j = await r.json();
      kind = j?.schoolInfo?.[1]?.row?.[0]?.SCHUL_KND_SC_NM || null;
    }
  } catch {}
  const schulKnd = kind?.includes('초') ? '02' : kind?.includes('중') ? '03' : kind?.includes('고') ? '04' : '02';

  const apiTypes = ['student_info','teacher_info','school_info','studentInfo','teacherInfo','학생수','교원수'];
  const builders = [
    (t) => `${SCHOOLINFO_BASE}?apiKey=${SCHOOLINFO_KEY}&apiType=${t}&pbanYr=${year}&schulKndCode=${schulKnd}&schulCode=${code}`,
    (t) => `${SCHOOLINFO_BASE}?apiKey=${SCHOOLINFO_KEY}&apiType=${t}&PBAN_YY=${year}&SCHUL_KND_SC_CODE=${schulKnd}&SCHUL_CODE=${code}`,
    (t) => `${SCHOOLINFO_BASE}?apiKey=${SCHOOLINFO_KEY}&apiType=${t}&schulCode=${code}&schulKindCode=${schulKnd}`,
  ];

  for (const apiType of apiTypes) {
    for (const build of builders) {
      const url = build(apiType);
      try {
        const r = await fetchWithTimeout(url, 8000);
        if (!r) { attempts.push({ apiType, urlPattern: url.split('?')[1], ok: false, error: 'no response' }); continue; }
        const txt = await r.text();
        attempts.push({
          apiType,
          urlPattern: url.split('?')[1],
          httpStatus: r.status,
          contentType: r.headers.get('content-type'),
          length: txt.length,
          preview: txt.slice(0, 400),
        });
      } catch (e) {
        attempts.push({ apiType, error: e.message });
      }
    }
  }

  res.json({ office, code, kind, schulKnd, year, attempts });
});

// ────────────────────────────────────────
// 농어민 상생 — 과잉생산·판로취약 농수산물 정보
// 출처: 농넷(nongnet.or.kr) · 바로정보(baroinfo.com)
// 공개 JSON API 부재 + CORS 차단 → 서버 프록시 best-effort + 큐레이션 폴백
// ────────────────────────────────────────
const farmSurplusCache = { t: 0, v: null };

// 월별 큐레이션 폴백 — 과잉생산·수급조절·판로지원 빈발 품목 (농식품부 수급동향 기반)
const FARM_SURPLUS_FALLBACK = {
  1:  ['배추','무','감귤','단감','건고추','쌀'],
  2:  ['배추','무','감귤','대파','양파','쌀'],
  3:  ['양파','대파','마늘','시금치','딸기','한라봉'],
  4:  ['양파','대파','마늘','봄동','참다래','애호박'],
  5:  ['양파','마늘','감자','마늘쫑','매실','토마토'],
  6:  ['감자','마늘','양파','매실','참외','수박'],
  7:  ['감자','수박','참외','복숭아','오이','애호박'],
  8:  ['수박','복숭아','포도','자두','오이','풋고추'],
  9:  ['배','사과','포도','대추','밤','고구마'],
  10: ['사과','배','대추','밤','고구마','무'],
  11: ['배추','무','사과','단감','감귤','고구마'],
  12: ['배추','무','감귤','단감','건고추','쌀'],
};

// 농수산물 수급정책 상시 지원 품목 (가격 등락 큰 민감 품목)
const FARM_SENSITIVE = ['배추','무','마늘','양파','대파','건고추','감자','쌀'];

async function tryFetchSurplusSources() {
  // 농넷/바로정보 페이지 best-effort 수집 (실패 시 null → 폴백)
  const sources = [
    'https://www.nongnet.or.kr/',
    'https://www.baroinfo.com/',
  ];
  const found = new Set();
  const KEYWORDS = ['배추','무','마늘','양파','대파','건고추','감자','쌀','사과','배','감귤','단감',
    '수박','참외','복숭아','포도','자두','토마토','오이','애호박','시금치','딸기','고구마','밤','대추'];
  for (const url of sources) {
    try {
      const r = await fetchWithTimeout(url, 8000);
      if (!r || !r.ok) continue;
      const html = await r.text();
      // 페이지 텍스트에서 과잉/수급/할인/판로 맥락 인근 품목명 추출 (단순 키워드 매칭)
      KEYWORDS.forEach(k => { if (html.includes(k)) found.add(k); });
    } catch (e) { /* skip */ }
  }
  return found.size ? [...found] : null;
}

app.get('/api/farm-surplus', async (req, res) => {
  // 6시간 캐시
  if (farmSurplusCache.v && Date.now() - farmSurplusCache.t < 6 * 3600 * 1000) {
    return res.json(farmSurplusCache.v);
  }
  const month = new Date().getMonth() + 1;
  const fallback = FARM_SURPLUS_FALLBACK[month] || FARM_SURPLUS_FALLBACK[1];

  let live = null;
  try { live = await tryFetchSurplusSources(); } catch (e) {}

  // live(농넷/바로정보) 우선, 폴백과 병합 (중복 제거, 최대 8개)
  const merged = [...new Set([...(live || []), ...fallback])].slice(0, 8);
  const result = {
    month,
    items: merged,
    sensitive: FARM_SENSITIVE,
    source: live ? 'nongnet+baroinfo+curated' : 'curated',
    sources: ['https://www.nongnet.or.kr/', 'https://www.baroinfo.com/'],
    updatedAt: new Date().toISOString(),
  };
  farmSurplusCache.t = Date.now();
  farmSurplusCache.v = result;
  res.json(result);
});

// ────────────────────────────────────────
// 정적 파일 (index.html, data/*, README, LICENSE)
// ────────────────────────────────────────
app.use(express.static(__dirname, { maxAge: '5m', extensions: ['html'] }));

// SPA fallback — 알 수 없는 경로는 index.html
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.listen(PORT, () => {
  console.log('🚀 kmeal-app server running on port ' + PORT);
});
