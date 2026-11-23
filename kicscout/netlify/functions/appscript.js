// netlify/functions/appscript.js
// Apps Script 프록시 — URL과 토큰을 서버사이드에서 관리하고, 입구를 좁힌 버전(2026-11-23).
//
// 이전 버전은 CORS 가 '*' 이고 아무나 아무 값이나 저장 요청을 보낼 수 있어서, 가짜 기록이 시트(랭킹 포함)에 들어갈 수 있었다.
// 아래 규칙으로 막는다.
//  1) 저장하는 요청(save, saveReport, agentContact, updateReportDone)은 이 사이트에서 온 것만 받는다.
//  2) 같은 사람(IP)이 짧은 시간에 너무 많이 부르면 막는다(저장·조회 모두, 코드 대입 공격 방지).
//  3) 알려진 action 만 받고, 값의 길이·숫자 범위에 상한을 둔다.
//  4) 시트에서 수식으로 읽힐 수 있는 값(=, +, -, @ 로 시작하는 짧은 글)은 맨 앞 기호를 지운다.
//  5) 다른 사이트의 브라우저가 응답을 읽지 못하게 CORS 를 이 사이트로만 연다.
// 페이지(index.html, index_en.html)가 보내는 요청 모양은 그대로 받는다.
//
// ★ lookup.html / lookup_en.html 은 아직 Apps Script 주소를 직접 부른다(이 프록시를 거치지 않는다).
//   그 주소가 공개 저장소에 있으므로, 완전히 막으려면 두 페이지를 이 프록시로 바꾸고 Apps Script 를 새로 배포해
//   새 주소를 환경 변수(APPS_SCRIPT_URL, APPS_SCRIPT_URL_EN)에 넣어야 한다.

const WRITE_ACTIONS = ['save', 'saveReport', 'agentContact', 'updateReportDone'];
const READ_ACTIONS = ['getReport', 'lookup', 'ranking'];
const POST_ACTIONS = ['saveReport', 'save'];

const MAX_BODY_CHARS = 300000;
const MAX_PARAMS = 80;
const MAX_KEY_CHARS = 40;
const MAX_VALUE_CHARS = 150000;
const MAX_SHORT_VALUE_CHARS = 300;
const MAX_NUMBER = 100000;

const WINDOW_MS = 10 * 60 * 1000;
const LIMITS = { write: 24, lookup: 30, ranking: 90 };
const hits = new Map();

function allowedOrigins(event) {
  const list = (process.env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  list.push('https://kickscoutreal.netlify.app');
  const host = String((event.headers && event.headers.host) || '').toLowerCase();
  if (host) list.push('https://' + host);
  return list;
}

function originAllowed(origin, event) {
  if (!origin) return false;
  const o = String(origin).toLowerCase().replace(/\/$/, '');
  if (allowedOrigins(event).includes(o)) return true;
  return /^https:\/\/[a-z0-9-]+--kickscoutreal\.netlify\.app$/.test(o);
}

// 이 사이트의 페이지가 보낸 요청인가(출처 확인). 같은 사이트의 GET 은 Origin 이 없고 Sec-Fetch-Site 가 same-origin 이다.
function fromThisSite(event) {
  const h = event.headers || {};
  if (h.origin) return originAllowed(h.origin, event);
  if (h['sec-fetch-site'] === 'same-origin') return true;
  if (h.referer) { try { return originAllowed(new URL(h.referer).origin, event); } catch (e) { return false; } }
  return false;
}

function clientIp(event) {
  const h = event.headers || {};
  return String(h['x-nf-client-connection-ip'] || String(h['x-forwarded-for'] || '').split(',')[0] || 'unknown').trim();
}

function tooMany(kind, ip, now) {
  const key = kind + ':' + ip;
  const recent = (hits.get(key) || []).filter((t) => now - t < WINDOW_MS);
  if (recent.length >= LIMITS[kind]) { hits.set(key, recent); return true; }
  recent.push(now);
  hits.set(key, recent);
  if (hits.size > 8000) { for (const [k, v] of hits) { if (!v.some((t) => now - t < WINDOW_MS)) hits.delete(k); } }
  return false;
}

// 값을 검사하고 정리한다. 받을 수 없는 모양이면 null.
function cleanParams(params, action) {
  const out = new URLSearchParams();
  let count = 0;
  for (const [k, v] of params) {
    count += 1;
    if (count > MAX_PARAMS || k.length > MAX_KEY_CHARS || v.length > MAX_VALUE_CHARS) return null;
    let value = v;
    // 시트 수식으로 읽히는 시작 기호 제거(짧은 글에만 적용, 긴 JSON 등은 그대로). '-' 하나만 있는 기본값은 그대로 둔다
    if (value.length <= MAX_SHORT_VALUE_CHARS) value = value.replace(/^[=+\-@\t\r]+(?=.)/, '');
    out.append(k, value);
  }
  if (action === 'save') {
    for (const key of ['age', 'maxSpeed', 'avgSpeed', 'distance', 'sprints', 'kneeL', 'kneeR', 'trunkLean', 'balance', 'score']) {
      const v = out.get(key);
      if (v === null || v === '') continue;
      const n = Number(v);
      if (!Number.isFinite(n) || Math.abs(n) > MAX_NUMBER) return null;
    }
    for (const key of ['name', 'email', 'position', 'grade', 'code']) {
      const v = out.get(key);
      if (v !== null && v.length > 120) return null;
    }
  }
  return out;
}

exports.handler = async function (event, context) {
  const origin = (event.headers && event.headers.origin) || '';
  const okOrigin = originAllowed(origin, event);
  const cors = okOrigin
    ? { 'Access-Control-Allow-Origin': origin, 'Vary': 'Origin', 'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS' }
    : { 'Vary': 'Origin' };
  const json = (statusCode, obj) => ({ statusCode, headers: { ...cors, 'Content-Type': 'application/json' }, body: JSON.stringify(obj) });

  if (event.httpMethod === 'OPTIONS') return { statusCode: okOrigin ? 200 : 403, headers: cors, body: '' };
  if (event.httpMethod !== 'GET' && event.httpMethod !== 'POST') return json(405, { error: 'Method Not Allowed' });

  const SCRIPT_URL_KR = process.env.APPS_SCRIPT_URL;
  const SCRIPT_URL_EN = process.env.APPS_SCRIPT_URL_EN;
  const SCRIPT_TOKEN = process.env.APPS_SCRIPT_TOKEN;
  if (!SCRIPT_URL_KR) return json(500, { error: 'Service unavailable' });

  try {
    // 쿼리 파라미터 수집 (GET) 또는 body에서 파싱 (POST)
    let params;
    if (event.httpMethod === 'POST' && event.body) {
      if (String(event.body).length > MAX_BODY_CHARS) return json(413, { error: 'Request too large' });
      params = new URLSearchParams(event.body);
    } else {
      params = new URLSearchParams(event.queryStringParameters || {});
    }

    const action = params.get('action') || '';
    const isWrite = WRITE_ACTIONS.includes(action);
    if (!isWrite && !READ_ACTIONS.includes(action)) return json(400, { error: 'Invalid request' });

    const ip = clientIp(event);
    const now = Date.now();
    if (isWrite) {
      if (!fromThisSite(event)) return json(403, { error: 'Forbidden' });
      if (tooMany('write', ip, now)) return json(429, { error: 'Too many requests' });
    } else if (action === 'ranking') {
      if (tooMany('ranking', ip, now)) return json(429, { error: 'Too many requests' });
    } else {
      if (tooMany('lookup', ip, now)) return json(429, { error: 'Too many requests' });
      const code = params.get('code');
      if (code !== null && !/^[A-Za-z0-9-]{6,24}$/.test(code)) return json(400, { error: 'Invalid request' });
    }

    const cleaned = cleanParams(params, action);
    if (!cleaned) return json(400, { error: 'Invalid request' });
    params = cleaned;

    // 서버에서 토큰 주입 (클라이언트가 보낸 _t는 무시)
    params.delete('_t');
    if (SCRIPT_TOKEN) params.set('_t', SCRIPT_TOKEN);

    const region = params.get('region') === 'EN' ? 'EN' : 'KR';

    // region에 따라 대상 URL 선택 (ranking은 항상 KR)
    let scriptUrl;
    if (action === 'ranking') {
      scriptUrl = SCRIPT_URL_KR;
    } else if (region === 'EN' && SCRIPT_URL_EN) {
      scriptUrl = SCRIPT_URL_EN;
    } else {
      scriptUrl = SCRIPT_URL_KR;
    }

    // 응답이 필요한 action (cors 호출)
    const needsResponse = READ_ACTIONS.includes(action);
    // 데이터가 큰 action은 POST로 전달 (URL 길이 제한 회피)
    const usePOST = POST_ACTIONS.includes(action);

    if (needsResponse) {
      const targetUrl = scriptUrl + '?' + params.toString();
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 20000);
      const resp = await fetch(targetUrl, { signal: controller.signal });
      clearTimeout(timeoutId);
      const data = await resp.text();
      return { statusCode: resp.status, headers: { ...cors, 'Content-Type': 'application/json' }, body: data };
    } else if (usePOST) {
      // POST body로 전달 — Apps Script doPost가 파싱
      await fetch(scriptUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: params.toString(),
      });
      return json(200, { status: 'sent' });
    } else {
      // 기타 저장 요청: GET으로 전달
      await fetch(scriptUrl + '?' + params.toString());
      return json(200, { status: 'sent' });
    }
  } catch (err) {
    const isTimeout = err && err.name === 'AbortError';
    return json(isTimeout ? 504 : 500, { error: isTimeout ? 'Timeout' : 'Server error' });
  }
};
