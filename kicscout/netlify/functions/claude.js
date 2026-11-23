// netlify/functions/claude.js
// Claude API 중계 — 누구나 호출해서 API 비용을 쓰지 못하도록 입구를 좁힌 버전(2026-11-23).
//
// 이전 버전은 CORS 가 '*' 이고 모델·글자 수·지시문·질문을 호출하는 사람이 마음대로 정할 수 있어서,
// 주소를 아는 누구나 이 사이트의 API 키로 Claude 를 쓸 수 있었다. 아래 규칙으로 막는다.
//  1) 이 사이트에서 온 요청만 받는다(Origin 확인).
//  2) 허용한 모델만 쓴다. 출력 글자 수(max_tokens)에 상한을 둔다.
//  3) 보낼 수 있는 글자 수·메시지 수·지시문 길이에 상한을 둔다.
//  4) 같은 사람(IP)이 짧은 시간에 너무 많이 부르면 막는다(실행 중인 인스턴스 안에서의 제한이라 완벽하진 않다).
//  5) 오류 내용을 밖으로 자세히 알려주지 않는다.
// 페이지(index.html, index_en.html)가 보내는 요청 모양(model, max_tokens, system, messages)은 그대로 받는다.
//
// ★ 가장 확실한 안전장치는 Anthropic 콘솔(console.anthropic.com)에서 월 사용 한도(spend limit)를 정해 두는 것이다.
//   이 파일의 제한은 그 한도에 닿기 전에 대부분의 남용을 막기 위한 것이다.

// 2026-06-15 에 claude-sonnet-4-20250514 가 종료되어 그 이름으로는 더 이상 호출할 수 없다(호출하면 오류가 나서
// 심층 리포트가 대체 문구로만 나갔다). 페이지(index.html, index_en.html)는 아직 옛 이름을 보내므로 서버에서 새 모델로 바꿔 부른다.
const CURRENT_MODEL = 'claude-sonnet-5-5';
const MODEL_ALIASES = { 'claude-sonnet-4-20250514': CURRENT_MODEL };
const ALLOWED_MODELS = [CURRENT_MODEL, ...Object.keys(MODEL_ALIASES)];
const MAX_TOKENS_CAP = 1500;
const MAX_BODY_CHARS = 60000;
const MAX_TOTAL_PROMPT_CHARS = 30000;
const MAX_SYSTEM_CHARS = 3000;
const MAX_MESSAGES = 4;
// 한 번의 심층 리포트가 4번 호출하므로 10분에 16번이면 리포트 4건 정도까지 허용된다.
const RATE_WINDOW_MS = 10 * 60 * 1000;
const RATE_LIMIT = 16;
const hits = new Map(); // ip -> [시각, ...]

function allowedOrigins(event) {
  const list = (process.env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  list.push('https://kickscoutreal.netlify.app');
  // 이 함수가 서비스되는 주소(사이트 자기 자신, 연결해 둔 도메인 포함)
  const host = String((event.headers && event.headers.host) || '').toLowerCase();
  if (host) list.push('https://' + host);
  return list;
}

function originAllowed(origin, event) {
  if (!origin) return false;
  const o = String(origin).toLowerCase().replace(/\/$/, '');
  if (allowedOrigins(event).includes(o)) return true;
  // Netlify 배포 미리보기: https://<배포이름>--kickscoutreal.netlify.app
  return /^https:\/\/[a-z0-9-]+--kickscoutreal\.netlify\.app$/.test(o);
}

function clientIp(event) {
  const h = event.headers || {};
  return String(h['x-nf-client-connection-ip'] || String(h['x-forwarded-for'] || '').split(',')[0] || 'unknown').trim();
}

function rateLimited(ip, now) {
  const recent = (hits.get(ip) || []).filter((t) => now - t < RATE_WINDOW_MS);
  if (recent.length >= RATE_LIMIT) { hits.set(ip, recent); return true; }
  recent.push(now);
  hits.set(ip, recent);
  if (hits.size > 5000) { for (const [k, v] of hits) { if (!v.some((t) => now - t < RATE_WINDOW_MS)) hits.delete(k); } }
  return false;
}

// 허용한 모양이면 정리된 요청을, 아니면 null 을 돌려준다.
function cleanRequest(body) {
  if (!body || typeof body !== 'object') return null;
  const asked = body.model || CURRENT_MODEL;
  if (!ALLOWED_MODELS.includes(asked)) return null;
  const model = MODEL_ALIASES[asked] || asked;
  let maxTokens = Math.floor(Number(body.max_tokens) || 800);
  maxTokens = Math.max(1, Math.min(MAX_TOKENS_CAP, maxTokens));
  const system = body.system == null || body.system === '' ? undefined : body.system;
  if (system !== undefined && (typeof system !== 'string' || system.length > MAX_SYSTEM_CHARS)) return null;
  const msgs = body.messages;
  if (!Array.isArray(msgs) || msgs.length < 1 || msgs.length > MAX_MESSAGES) return null;
  let total = 0;
  const messages = [];
  for (const m of msgs) {
    if (!m || typeof m !== 'object' || !['user', 'assistant'].includes(m.role) || typeof m.content !== 'string' || !m.content) return null;
    total += m.content.length;
    messages.push({ role: m.role, content: m.content });
  }
  if (total > MAX_TOTAL_PROMPT_CHARS || messages[0].role !== 'user') return null;
  return { model, max_tokens: maxTokens, ...(system ? { system } : {}), messages };
}

exports.handler = async function (event, context) {
  const origin = (event.headers && event.headers.origin) || '';
  const okOrigin = originAllowed(origin, event);
  const cors = okOrigin
    ? { 'Access-Control-Allow-Origin': origin, 'Vary': 'Origin', 'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Allow-Methods': 'POST, OPTIONS' }
    : { 'Vary': 'Origin' };
  const json = (statusCode, obj) => ({ statusCode, headers: { ...cors, 'Content-Type': 'application/json' }, body: JSON.stringify(obj) });

  if (event.httpMethod === 'OPTIONS') return { statusCode: okOrigin ? 200 : 403, headers: cors, body: '' };
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method Not Allowed' });
  if (!okOrigin) return json(403, { error: 'Forbidden' });
  if (!process.env.CLAUDE_API_KEY) return json(500, { error: 'Service unavailable' });
  if (String(event.body || '').length > MAX_BODY_CHARS) return json(413, { error: 'Request too large' });
  if (rateLimited(clientIp(event), Date.now())) return json(429, { error: 'Too many requests' });

  let payload;
  try { payload = cleanRequest(JSON.parse(event.body || '{}')); } catch (e) { payload = null; }
  if (!payload) return json(400, { error: 'Invalid request' });

  // AbortController 로 24초 타임아웃 설정 (Netlify 26초 제한 내)
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 24000);
  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.CLAUDE_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    clearTimeout(timeoutId);
    const data = await response.json();
    if (!response.ok) return json(502, { error: 'Upstream error', type: data && data.error && data.error.type ? String(data.error.type) : undefined });
    // 페이지가 읽는 것은 content 뿐이다. 그 밖의 값은 돌려주지 않는다.
    return json(200, { content: data.content, stop_reason: data.stop_reason });
  } catch (err) {
    clearTimeout(timeoutId);
    const isTimeout = err && err.name === 'AbortError';
    return json(isTimeout ? 504 : 500, { error: isTimeout ? 'Timeout' : 'Server error' });
  }
};
