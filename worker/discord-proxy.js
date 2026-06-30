/**
 * discord-proxy.js — BOMUbrary 用 Cloudflare Worker
 *
 * 役割は2つ:
 *  1. 送信プロキシ:  GAS → (X-Proxy-Secret) → Worker → discord.com
 *     GAS の egress IP が Discord エッジに 40333 で弾かれる問題を回避する。
 *     GAS は DISCORD_PROXY_BASE をこの Worker の URL にするだけ。
 *
 *  2. Interactions エンドポイント:  Discord → Worker(/interactions)
 *     ed25519 署名を検証し、PING に即応答。Slash Command は即 defer(type5) して
 *     3秒制約をクリアし、裏で GAS に本文生成を委譲 → followup で結果を返す。
 *     これにより GAS のコールドスタート遅延が 3秒制約に影響しなくなる。
 *
 * 必要な環境変数（wrangler secret / ダッシュボードの Variables）:
 *   DISCORD_PUBLIC_KEY  … アプリの Public Key（General Information）
 *   DISCORD_APP_ID      … アプリの Application (Client) ID
 *   GAS_EXEC_URL        … GAS Web App の /exec URL
 *   PROXY_SECRET        … GAS と共有する任意のシークレット（推測困難な文字列）
 */

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // ヘルスチェック
    if (request.method === 'GET' && url.pathname === '/') {
      return new Response('BOMUbrary discord-proxy: OK', { status: 200 });
    }

    // ── Discord Interactions エンドポイント ──
    if (url.pathname === '/interactions' && request.method === 'POST') {
      return handleInteractions(request, env, ctx);
    }

    // ── 送信プロキシ（GAS → discord.com） ──
    return handleProxy(request, env, url);
  },
};

// ───────────────────────────────────────────────────────────────
//  Interactions
// ───────────────────────────────────────────────────────────────
async function handleInteractions(request, env, ctx) {
  const raw = await request.text();
  const valid = await verifySignature(env.DISCORD_PUBLIC_KEY, request, raw);
  if (!valid) {
    return new Response('invalid request signature', { status: 401 });
  }

  const interaction = JSON.parse(raw);

  // 1 = PING → PONG（エンドポイント検証もこれで通る）
  if (interaction.type === 1) {
    return json({ type: 1 });
  }

  // 2 = APPLICATION_COMMAND → 即 defer(ephemeral) し、裏で GAS に本文生成を依頼
  if (interaction.type === 2) {
    ctx.waitUntil(resolveAndFollowup(env, interaction));
    return json({ type: 5, data: { flags: 64 } }); // 5 = DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE
  }

  // それ以外は無難に PONG
  return json({ type: 1 });
}

/** GAS に本文生成を依頼し、interaction の @original を followup で更新する */
async function resolveAndFollowup(env, interaction) {
  let data = { content: '処理中にエラーが発生しました。', flags: 64 };
  try {
    const res = await fetch(env.GAS_EXEC_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'interaction', secret: env.PROXY_SECRET, interaction }),
      redirect: 'follow', // GAS は googleusercontent へ302するため追従
    });
    const j = await res.json();
    if (j && j.data) data = j.data;
  } catch (e) {
    data = { content: 'サーバー応答の取得に失敗しました: ' + e.message, flags: 64 };
  }

  const url = 'https://discord.com/api/v10/webhooks/' + env.DISCORD_APP_ID
    + '/' + interaction.token + '/messages/@original';
  await fetch(url, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
}

/** ed25519 署名検証（Cloudflare Workers の WebCrypto を使用） */
async function verifySignature(publicKeyHex, request, rawBody) {
  const sig = request.headers.get('X-Signature-Ed25519');
  const ts = request.headers.get('X-Signature-Timestamp');
  if (!sig || !ts || !publicKeyHex) return false;
  try {
    const key = await crypto.subtle.importKey(
      'raw', hexToBytes(publicKeyHex), { name: 'Ed25519' }, false, ['verify']
    );
    return await crypto.subtle.verify(
      { name: 'Ed25519' }, key, hexToBytes(sig),
      new TextEncoder().encode(ts + rawBody)
    );
  } catch (e) {
    return false;
  }
}

// ───────────────────────────────────────────────────────────────
//  送信プロキシ
// ───────────────────────────────────────────────────────────────
async function handleProxy(request, env, url) {
  const secret = request.headers.get('X-Proxy-Secret');
  if (!env.PROXY_SECRET || secret !== env.PROXY_SECRET) {
    return new Response('forbidden', { status: 403 });
  }

  const target = 'https://discord.com' + url.pathname + url.search;
  const headers = new Headers(request.headers);
  headers.delete('X-Proxy-Secret');
  headers.delete('Host');
  headers.delete('CF-Connecting-IP');

  const init = {
    method: request.method,
    headers,
    redirect: 'manual',
  };
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    init.body = await request.arrayBuffer();
  }

  const resp = await fetch(target, init);
  // レスポンスをそのまま返す
  const outHeaders = new Headers(resp.headers);
  outHeaders.delete('Content-Encoding'); // 二重圧縮回避
  return new Response(resp.body, { status: resp.status, headers: outHeaders });
}

// ───────────────────────────────────────────────────────────────
//  helpers
// ───────────────────────────────────────────────────────────────
function json(obj) {
  return new Response(JSON.stringify(obj), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

function hexToBytes(hex) {
  const clean = String(hex).trim();
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(clean.substr(i * 2, 2), 16);
  }
  return out;
}
