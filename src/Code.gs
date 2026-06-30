/**
 * Code.gs
 * Web App のエントリポイント（doGet / doPost）と、フロントエンドが
 * google.script.run 経由で呼ぶ RPC 関数群。
 *
 * RPC 規約:
 *   - すべての公開関数は第1引数に session token を受け取る
 *   - フロントの gasCall ラッパーが token を自動で先頭に差し込む
 */

// ─── HTMLテンプレートのインクルード（仕様書の include パターン） ───
function include(filename) {
  return HtmlService.createHtmlOutputFromFile(filename).getContent();
}

// ─── doGet: OAuthコールバック or アプリ配信 ───────────────────────
function doGet(e) {
  const params = (e && e.parameter) || {};

  // Discord OAuth コールバック
  if (params.code) {
    let result;
    try {
      result = Auth.handleCallback(params.code, params.state);
    } catch (err) {
      result = { error: '認証中にエラーが発生しました: ' + err.message };
    }
    return renderAuthBridge(result);
  }

  // 通常のアプリ配信
  const tmpl = HtmlService.createTemplateFromFile('Index');
  return tmpl.evaluate()
    .setTitle('起業部 本棚 — BOMUbrary')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1.0')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

/**
 * OAuth結果をフロントへ渡すための中間ページ。
 * 成功時は token を sessionStorage に保存してアプリ本体（/exec）へ遷移する。
 */
function renderAuthBridge(result) {
  const safe = JSON.stringify(result).replace(/</g, '\\u003c');
  const url = Config.webappUrl();
  const html = ''
    + '<!DOCTYPE html><html lang="ja"><head><meta charset="UTF-8">'
    + '<style>body{font-family:sans-serif;display:flex;height:100vh;align-items:center;'
    + 'justify-content:center;margin:0;background:#f0f4ff;color:#1a2b8a}</style></head>'
    + '<body><div id="m">ログイン処理中...</div><script>'
    + 'var r=' + safe + ';'
    + 'var base=' + JSON.stringify(url) + ';'
    + 'function go(t){'
    + '  try{sessionStorage.setItem("bomu_token",t);}catch(e){}'
    + '  var dest=base+"#token="+encodeURIComponent(t);'
    + '  try{ (window.top||window).location.replace(dest); }catch(e){ location.replace(dest); }'
    + '}'
    + 'if(r&&r.token){go(r.token);}'
    + 'else{document.getElementById("m").innerHTML='
    + '((r&&r.error)||"ログインに失敗しました")+"<br><br><a target=\\"_top\\" href=\\""+base+"\\">戻る</a>";}'
    + '</script></body></html>';
  return HtmlService.createHtmlOutput(html)
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

// ─── doPost: Discord Interactions（Slash Commands） ───────────────
function doPost(e) {
  try {
    return Discord.handleInteraction(e);
  } catch (err) {
    return ContentService.createTextOutput(
      JSON.stringify({ type: 4, data: { content: 'エラー: ' + err.message } })
    ).setMimeType(ContentService.MimeType.JSON);
  }
}

// ─── RPC ヘルパー ─────────────────────────────────────────────────
function requireMember(token) {
  const member = Auth.currentMember(token);
  if (!member) throw new Error('ログインが必要です。');
  return member;
}

function requireAdmin(token) {
  const member = requireMember(token);
  if (member.role !== 'admin') throw new Error('管理者権限が必要です。');
  return member;
}

// ═══════════════════════════════════════════════════════════════
//  認証系 RPC
// ═══════════════════════════════════════════════════════════════
function getAuthUrl() {
  return Auth.buildAuthUrl();
}

function getSession(token) {
  const member = Auth.currentMember(token);
  if (!member) return null;
  return Members.toPublic(member);
}

function logout(token) {
  Auth.destroySession(token);
  return true;
}

// ═══════════════════════════════════════════════════════════════
//  蔵書系 RPC
// ═══════════════════════════════════════════════════════════════
function getBooks(token) {
  requireMember(token);
  return Books.list();
}

function getBookById(token, bookId) {
  requireMember(token);
  return Books.detail(bookId);
}

function lookupIsbn(token, isbn) {
  requireMember(token);
  return Books.lookupIsbn(isbn);
}

function registerBook(token, payload) {
  const member = requireMember(token);
  return Books.register(member, payload);
}

function updateBook(token, bookId, patch) {
  const member = requireMember(token);
  return Books.updateBook(member, bookId, patch);
}

function deleteBook(token, bookId) {
  const member = requireMember(token);
  return Books.deleteBook(member, bookId);
}

// ═══════════════════════════════════════════════════════════════
//  タグ系 RPC
// ═══════════════════════════════════════════════════════════════
function getTags(token) {
  requireMember(token);
  return Tags.list();
}

function createTag(token, name) {
  const member = requireMember(token);
  return Tags.create(member, name);
}

function setBookTags(token, bookId, tagIds) {
  const member = requireMember(token);
  return Tags.setBookTags(member, bookId, tagIds);
}

function mergeTags(token, fromTagId, intoTagId) {
  requireAdmin(token);
  return Tags.merge(fromTagId, intoTagId);
}

function deleteTag(token, tagId) {
  requireAdmin(token);
  return Tags.remove(tagId);
}

// ═══════════════════════════════════════════════════════════════
//  貸出系 RPC
// ═══════════════════════════════════════════════════════════════
function requestLend(token, bookId) {
  const member = requireMember(token);
  return Lendings.requestLend(member, bookId);
}

function approveLend(token, bookId, borrowerId) {
  const member = requireMember(token);
  return Lendings.approveLend(member, bookId, borrowerId);
}

function returnBook(token, lendingId, condition) {
  const member = requireMember(token);
  return Lendings.returnBook(member, lendingId, condition);
}

function requestExtension(token, lendingId) {
  const member = requireMember(token);
  return Lendings.requestExtension(member, lendingId);
}

function decideExtension(token, lendingId, approve) {
  const member = requireMember(token);
  return Lendings.decideExtension(member, lendingId, approve);
}

function joinWaitlist(token, bookId) {
  const member = requireMember(token);
  return Lendings.joinWaitlist(member, bookId);
}

function leaveWaitlist(token, bookId) {
  const member = requireMember(token);
  return Lendings.leaveWaitlist(member, bookId);
}

function markAsRead(token, lendingId) {
  const member = requireMember(token);
  return Lendings.markAsRead(member, lendingId);
}

// ═══════════════════════════════════════════════════════════════
//  レビュー系 RPC
// ═══════════════════════════════════════════════════════════════
function getReviews(token, bookId) {
  requireMember(token);
  return Reviews.listByBook(bookId);
}

function postReview(token, payload) {
  const member = requireMember(token);
  return Reviews.post(member, payload);
}

// ═══════════════════════════════════════════════════════════════
//  購入リクエスト系 RPC
// ═══════════════════════════════════════════════════════════════
function getRequests(token) {
  requireMember(token);
  return Requests.list();
}

function addRequest(token, payload) {
  const member = requireMember(token);
  return Requests.add(member, payload);
}

function voteRequest(token, requestId) {
  const member = requireMember(token);
  return Requests.vote(member, requestId);
}

function decideRequest(token, requestId, action) {
  const member = requireAdmin(token);
  return Requests.decide(member, requestId, action);
}

// ═══════════════════════════════════════════════════════════════
//  読書会スレッド系 RPC
// ═══════════════════════════════════════════════════════════════
function getForumPosts(token, bookId) {
  requireMember(token);
  return Forum.listByBook(bookId);
}

function postForum(token, bookId, content) {
  const member = requireMember(token);
  return Forum.post(member, bookId, content);
}

// ═══════════════════════════════════════════════════════════════
//  バトンリレー系 RPC
// ═══════════════════════════════════════════════════════════════
function getBatonHistory(token, bookId) {
  requireMember(token);
  return Baton.listByBook(bookId);
}

function passBaton(token, bookId, toMemberId, message) {
  const member = requireMember(token);
  return Baton.pass(member, bookId, toMemberId, message);
}

// ═══════════════════════════════════════════════════════════════
//  マイページ系 RPC
// ═══════════════════════════════════════════════════════════════
function getMyPage(token) {
  const member = requireMember(token);
  return Members.myPage(member);
}

function getMembers(token) {
  requireMember(token);
  return Members.listPublic();
}

function addWishlist(token, payload) {
  const member = requireMember(token);
  return Members.addWishlist(member, payload);
}

function removeWishlist(token, wishlistId) {
  const member = requireMember(token);
  return Members.removeWishlist(member, wishlistId);
}

// ═══════════════════════════════════════════════════════════════
//  管理系 RPC
// ═══════════════════════════════════════════════════════════════
function getAdminStats(token) {
  requireAdmin(token);
  return Admin.stats();
}

function getOverdueList(token) {
  requireAdmin(token);
  return Admin.overdueList();
}

function addMemberToWhitelist(token, discordId, username, role) {
  requireAdmin(token);
  return Admin.addMember(discordId, username, role);
}

function removeMemberFromWhitelist(token, memberId) {
  requireAdmin(token);
  return Admin.removeMember(memberId);
}

function clearPenalty(token, memberId) {
  requireAdmin(token);
  return Penalty.clear(memberId);
}
