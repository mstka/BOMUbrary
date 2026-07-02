/**
 * Main.gs — 認証・エントリポイント・RPC・定期処理
 *  統合元: Auth.gs / Code.gs / Cron.gs
 */

/* ======================================================================
 *  Auth (Discord OAuth2 / session)
 * ==================================================================== */

/**
 * Auth.gs
 * Discord OAuth2 ログイン + セッション管理。
 *
 * フロー（仕様書準拠）:
 *   1. Web App で「Discordでログイン」→ Discord認可画面へリダイレクト
 *   2. 認可後、GAS の doGet(?code=...) にコールバック
 *   3. code を access_token に交換
 *   4. access_token でユーザー情報・所属ギルド確認（guilds.members.read）
 *   5. members シートの discord_id と照合（ホワイトリスト）
 *   6. セッショントークンを発行し CacheService + sessions シートで管理
 */

const Auth = (function () {
  const DISCORD_API = 'https://discord.com/api';
  const SCOPES = 'identify guilds.members.read';

  /** OAuth2 認可URLを生成 */
  function buildAuthUrl() {
    const state = Utilities.getUuid();
    CacheService.getScriptCache().put('oauth_state_' + state, '1', 600);
    const params = {
      client_id: Config.discordClientId(),
      redirect_uri: Config.webappUrl(),
      response_type: 'code',
      scope: SCOPES,
      state: state,
      prompt: 'consent',
    };
    const qs = Object.keys(params)
      .map(function (k) { return k + '=' + encodeURIComponent(params[k]); })
      .join('&');
    return 'https://discord.com/oauth2/authorize?' + qs;
  }

  /** code を access_token に交換 */
  function exchangeCode(code) {
    const res = UrlFetchApp.fetch(DISCORD_API + '/oauth2/token', {
      method: 'post',
      contentType: 'application/x-www-form-urlencoded',
      muteHttpExceptions: true,
      payload: {
        client_id: Config.discordClientId(),
        client_secret: Config.discordClientSecret(),
        grant_type: 'authorization_code',
        code: code,
        redirect_uri: Config.webappUrl(),
      },
    });
    if (res.getResponseCode() !== 200) {
      throw new Error('トークン交換に失敗: ' + res.getContentText());
    }
    return JSON.parse(res.getContentText());
  }

  /** access_token から Discord ユーザー情報を取得 */
  function fetchDiscordUser(accessToken) {
    const res = UrlFetchApp.fetch(DISCORD_API + '/users/@me', {
      headers: { Authorization: 'Bearer ' + accessToken },
      muteHttpExceptions: true,
    });
    if (res.getResponseCode() !== 200) {
      throw new Error('ユーザー情報取得に失敗: ' + res.getContentText());
    }
    return JSON.parse(res.getContentText());
  }

  /** 起業部ギルドのメンバーか確認し、ロール情報を返す（非メンバーなら null） */
  function fetchGuildMembership(accessToken) {
    const guildId = Config.discordGuildId();
    if (!guildId) return { ok: true, roles: [] }; // ギルド未設定なら確認スキップ
    const res = UrlFetchApp.fetch(
      DISCORD_API + '/users/@me/guilds/' + guildId + '/member',
      { headers: { Authorization: 'Bearer ' + accessToken }, muteHttpExceptions: true }
    );
    if (res.getResponseCode() !== 200) return null; // 非メンバー
    const member = JSON.parse(res.getContentText());
    return { ok: true, roles: member.roles || [] };
  }

  function avatarUrl(user) {
    if (user.avatar) {
      return 'https://cdn.discordapp.com/avatars/' + user.id + '/' + user.avatar + '.png';
    }
    return '';
  }

  /**
   * OAuth コールバック処理。成功時はセッショントークンを返す。
   * members に未登録の Discord ユーザーはホワイトリスト外として弾く。
   */
  function handleCallback(code, state) {
    if (!state || !CacheService.getScriptCache().get('oauth_state_' + state)) {
      return { error: 'セッションの有効期限が切れました。もう一度ログインしてください。' };
    }
    CacheService.getScriptCache().remove('oauth_state_' + state);

    const token = exchangeCode(code);
    const discordUser = fetchDiscordUser(token.access_token);
    const membership = fetchGuildMembership(token.access_token);
    if (!membership) {
      return { error: '起業部 Discord サーバーのメンバーではありません。' };
    }

    // ホワイトリスト照合
    let member = SheetDB.find('members', function (m) {
      return String(m.discord_id) === String(discordUser.id);
    });

    if (!member) {
      // ADMIN_DISCORD_IDS に含まれていれば自動で管理者登録、それ以外は拒否
      if (Config.adminDiscordIds().indexOf(discordUser.id) >= 0) {
        member = registerMember(discordUser, 'admin');
      } else {
        return { error: 'このアカウントは部員リストに登録されていません。管理者に登録を依頼してください。' };
      }
    } else {
      // プロフィール（ユーザー名・アバター）を最新化
      SheetDB.update('members', 'member_id', member.member_id, {
        discord_username: discordUser.global_name || discordUser.username,
        avatar_url: avatarUrl(discordUser),
      });
      member.discord_username = discordUser.global_name || discordUser.username;
      member.avatar_url = avatarUrl(discordUser);
    }

    const sessionToken = createSession(member.member_id);
    return { token: sessionToken, member: Members.toPublic(member) };
  }

  function registerMember(discordUser, role) {
    const member = {
      member_id: Utils.uuid(),
      discord_id: discordUser.id,
      discord_username: discordUser.global_name || discordUser.username,
      avatar_url: avatarUrl(discordUser),
      role: role || 'member',
      penalty_until: '',
      penalty_count: 0,
      last_penalty_at: '',
      joined_at: Utils.now(),
    };
    SheetDB.insert('members', member);
    return member;
  }

  /** セッショントークン発行（CacheService 優先、sessions シートにも保存） */
  function createSession(memberId) {
    const token = Utilities.getUuid() + Utilities.getUuid().replace(/-/g, '');
    const now = Utils.now();
    const expires = Utils.addDays(now, 0);
    expires.setSeconds(expires.getSeconds() + Rules.SESSION_TTL_SECONDS);

    CacheService.getScriptCache().put('session_' + token, memberId, Rules.SESSION_TTL_SECONDS);
    SheetDB.insert('sessions', {
      token: token,
      member_id: memberId,
      created_at: now,
      expires_at: expires,
    });
    return token;
  }

  /** トークンから member_id を解決（キャッシュ → シート） */
  function resolveMemberId(token) {
    if (!token) return null;
    const cached = CacheService.getScriptCache().get('session_' + token);
    if (cached) return cached;

    const sess = SheetDB.find('sessions', function (s) { return s.token === token; });
    if (!sess) return null;
    const exp = Utils.parseDate(sess.expires_at);
    if (exp && exp.getTime() < Date.now()) return null;
    // キャッシュを温め直す
    CacheService.getScriptCache().put('session_' + token, sess.member_id, Rules.SESSION_TTL_SECONDS);
    return sess.member_id;
  }

  /** トークンから現在のメンバー（DBオブジェクト）を取得 */
  function currentMember(token) {
    const memberId = resolveMemberId(token);
    if (!memberId) return null;
    return SheetDB.find('members', function (m) { return m.member_id === memberId; });
  }

  function destroySession(token) {
    if (!token) return;
    CacheService.getScriptCache().remove('session_' + token);
    SheetDB.remove('sessions', function (s) { return s.token === token; });
  }

  return {
    buildAuthUrl: buildAuthUrl,
    handleCallback: handleCallback,
    currentMember: currentMember,
    resolveMemberId: resolveMemberId,
    destroySession: destroySession,
  };
})();

/* ======================================================================
 *  Code (doGet / doPost / RPC)
 * ==================================================================== */

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
 * 成功時は token を sessionStorage に保存し、アプリ本体（/exec）へ遷移する。
 *
 * 注: GAS のサンドボックス iframe は allow-top-navigation-by-user-activation のため、
 * ユーザー操作（クリック）が無いと top 遷移できない。よって自動遷移は best-effort とし、
 * 確実な導線として「アプリを開く」ボタン（target=_top のアンカー）を必ず表示する。
 */
function renderAuthBridge(result) {
  const safe = JSON.stringify(result).replace(/</g, '\\u003c');
  const url = Config.webappUrl();
  const html = [
    '<!DOCTYPE html><html lang="ja"><head><meta charset="UTF-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1.0">',
    '<style>',
    'body{font-family:sans-serif;display:flex;min-height:100vh;align-items:center;justify-content:center;margin:0;background:#f0f4ff;color:#1a2b8a;text-align:center}',
    '.box{padding:24px}',
    '.btn{display:inline-block;margin-top:16px;background:#4f6ef7;color:#fff;text-decoration:none;padding:12px 24px;border-radius:12px;font-weight:600}',
    '.err{color:#c0392b}',
    '</style></head>',
    '<body><div class="box" id="box">ログイン処理中...</div><script>',
    'var r=' + safe + ';',
    'var base=' + JSON.stringify(url) + ';',
    'var box=document.getElementById("box");',
    'if(r&&r.token){',
    '  try{sessionStorage.setItem("bomu_token",r.token);}catch(e){}',
    '  var dest=base+"#token="+encodeURIComponent(r.token);',
    // best-effort の自動遷移（ジェスチャー無しだとブロックされ得る）
    '  try{ (window.top||window).location.replace(dest); }catch(e){}',
    // 確実な導線: クリック=ユーザー操作で top 遷移
    '  box.innerHTML="ログインに成功しました。<br><a class=\\"btn\\" target=\\"_top\\" href=\\""+dest+"\\">アプリを開く</a>";',
    '}else{',
    '  box.innerHTML="<span class=\\"err\\">"+((r&&r.error)||"ログインに失敗しました")+"</span><br><a class=\\"btn\\" target=\\"_top\\" href=\\""+base+"\\">戻る</a>";',
    '}',
    '</script></body></html>'
  ].join('');
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

function uploadCover(token, payload) {
  const member = requireMember(token);
  return Books.uploadCover(member, payload);
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

/* ======================================================================
 *  Cron (time-driven triggers)
 * ==================================================================== */

/**
 * Cron.gs
 * GASの時間主導トリガーで動く定期処理群。
 * installTriggers() を一度実行するとトリガーが登録される。
 */

// ─── トリガー登録（手動で一度実行） ──────────────────────────────
function installTriggers() {
  // 既存の同名トリガーを掃除
  ScriptApp.getProjectTriggers().forEach(function (t) {
    const fn = t.getHandlerFunction();
    if (['cronDailyMorning', 'cronHourly', 'cronDailyMidnight'].indexOf(fn) >= 0) {
      ScriptApp.deleteTrigger(t);
    }
  });

  // 毎日 AM9:00 — 返却リマインド・書誌補完
  ScriptApp.newTrigger('cronDailyMorning').timeBased().everyDays(1).atHour(9).create();
  // 毎時 — 待ちリスト確認
  ScriptApp.newTrigger('cronHourly').timeBased().everyHours(1).create();
  // 毎日 AM0:00 — バッジ判定・ペナルティリセット
  ScriptApp.newTrigger('cronDailyMidnight').timeBased().everyDays(1).atHour(0).create();

  return 'トリガーを登録しました。';
}

// ─── 毎日 AM9:00 ─────────────────────────────────────────────────
function cronDailyMorning() {
  sendDueReminders();
  enrichPendingBooks();
}

/** 返却期限3日前・当日にDM通知 */
function sendDueReminders() {
  const now = Utils.now();
  let sent = 0;
  SheetDB.filter('lendings', function (l) { return !l.returned_at && l.lent_at; })
    .forEach(function (l) {
      const due = Utils.parseDate(l.due_date);
      if (!due) return;
      const days = Utils.daysBetween(now, due); // 残り日数
      const book = Books.raw(l.book_id);
      const title = book ? book.title : 'お借りの本';

      if (Utils.isSameDay(now, due)) {
        Discord.notifyMember(l.borrower_id,
          '📅 **本日返却期限**\n「' + title + '」の返却期限は本日です。');
        sent++;
      } else if (days === 3) {
        Discord.notifyMember(l.borrower_id,
          '⏰ **返却期限3日前**\n「' + title + '」の返却期限は ' + Utils.fmtDate(due) + ' です。');
        sent++;
      }
    });
  return sent;
}

/** pending_enrichment フラグのある本をNDL/Google Booksで再取得・補完 */
function enrichPendingBooks() {
  let enriched = 0;
  SheetDB.filter('books', function (b) { return b.pending_enrichment && b.isbn; })
    .forEach(function (b) {
      const meta = Books.lookupIsbn(b.isbn);
      if (!meta) return;
      SheetDB.update('books', 'book_id', b.book_id, {
        title: b.title || meta.title,
        author: b.author || meta.author,
        publisher: b.publisher || meta.publisher,
        cover_url: b.cover_url || meta.cover_url,
        page_count: b.page_count || meta.page_count,
        pending_enrichment: false,
      });
      Discord.notifyMember(b.owner_id,
        '📖 「' + (b.title || meta.title) + '」の書誌情報を自動補完しました。');
      enriched++;
    });
  return enriched;
}

// ─── 毎時 ────────────────────────────────────────────────────────
function cronHourly() {
  // 待ちリスト先頭で未通知かつ本が空きなら通知
  let notified = 0;
  const books = {};
  SheetDB.read('books').forEach(function (b) { books[b.book_id] = b; });

  // book_id ごとに待ちリストをまとめる
  const byBook = {};
  SheetDB.read('waitlist').forEach(function (w) {
    if (!byBook[w.book_id]) byBook[w.book_id] = [];
    byBook[w.book_id].push(w);
  });

  Object.keys(byBook).forEach(function (bookId) {
    const book = books[bookId];
    if (!book || book.status !== 'available') return; // 貸出中ならスキップ
    const queue = byBook[bookId].sort(function (a, b) {
      return new Date(a.registered_at) - new Date(b.registered_at);
    });
    const next = queue.filter(function (w) { return !w.notified; })[0];
    if (!next) return;
    SheetDB.update('waitlist', 'waitlist_id', next.waitlist_id, { notified: true });
    Discord.notifyMember(next.member_id,
      '🔔 「' + book.title + '」が空きました。借りますか？\n'
      + Config.webappUrl() + '#/detail?book=' + bookId);
    notified++;
  });
  return notified;
}

// ─── 毎日 AM0:00 ─────────────────────────────────────────────────
function cronDailyMidnight() {
  Badges.checkAll();
  Penalty.resetExpiredCounts();
}
