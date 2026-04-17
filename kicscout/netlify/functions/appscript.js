// netlify/functions/appscript.js
// Apps Script 프록시 — URL과 토큰을 서버사이드에서 관리
exports.handler = async function(event, context) {
  const CORS_HEADERS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS'
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers: CORS_HEADERS, body: '' };
  }

  const SCRIPT_URL_KR = process.env.APPS_SCRIPT_URL;
  const SCRIPT_URL_EN = process.env.APPS_SCRIPT_URL_EN;
  const SCRIPT_TOKEN = process.env.APPS_SCRIPT_TOKEN;

  if (!SCRIPT_URL_KR) {
    return {
      statusCode: 500,
      headers: CORS_HEADERS,
      body: JSON.stringify({ error: 'APPS_SCRIPT_URL not configured' })
    };
  }

  try {
    // 쿼리 파라미터 수집 (GET) 또는 body에서 파싱 (POST)
    let params;
    if (event.httpMethod === 'POST' && event.body) {
      params = new URLSearchParams(event.body);
    } else {
      params = new URLSearchParams(event.queryStringParameters || {});
    }

    // 서버에서 토큰 주입 (클라이언트가 보낸 _t는 무시)
    if (SCRIPT_TOKEN) {
      params.set('_t', SCRIPT_TOKEN);
    }

    const action = params.get('action') || '';
    const region = params.get('region') || 'KR';

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
    const needsResponse = ['getReport', 'lookup', 'ranking'].includes(action);

    // 데이터가 큰 action은 POST로 전달 (URL 길이 제한 회피)
    const usePOST = ['saveReport', 'save'].includes(action);

    if (needsResponse) {
      const targetUrl = scriptUrl + '?' + params.toString();
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 20000);

      const resp = await fetch(targetUrl, { signal: controller.signal });
      clearTimeout(timeoutId);

      const data = await resp.text();
      return {
        statusCode: resp.status,
        headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
        body: data
      };
    } else if (usePOST) {
      // POST body로 전달 — Apps Script doPost가 파싱
      await fetch(scriptUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: params.toString()
      });
      return {
        statusCode: 200,
        headers: CORS_HEADERS,
        body: JSON.stringify({ status: 'sent' })
      };
    } else {
      // 기타 저장 요청: GET으로 전달
      await fetch(scriptUrl + '?' + params.toString());
      return {
        statusCode: 200,
        headers: CORS_HEADERS,
        body: JSON.stringify({ status: 'sent' })
      };
    }
  } catch (err) {
    const isTimeout = err.name === 'AbortError';
    return {
      statusCode: isTimeout ? 504 : 500,
      headers: CORS_HEADERS,
      body: JSON.stringify({ error: isTimeout ? 'Apps Script timeout' : err.message })
    };
  }
};
