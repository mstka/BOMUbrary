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
