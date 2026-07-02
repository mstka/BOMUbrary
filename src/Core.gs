/**
 * Core.gs — 基盤レイヤー（設定・データ層・初期セットアップ）
 *  統合元: Config.gs / Utils.gs / Setup.gs
 */

/* ======================================================================
 *  Config
 * ==================================================================== */

/**
 * Config.gs
 * スクリプトプロパティから設定値を読み出す薄いラッパー。
 *
 * 必要なスクリプトプロパティ（GASエディタ → プロジェクトの設定 → スクリプトプロパティ）:
 *   SPREADSHEET_ID       … DBに使うスプレッドシートのID
 *   DISCORD_CLIENT_ID    … Discord アプリの Client ID
 *   DISCORD_CLIENT_SECRET… Discord アプリの Client Secret
 *   DISCORD_BOT_TOKEN    … Discord Bot トークン（DM/チャンネル通知・メンバー確認用）
 *   DISCORD_GUILD_ID     … 起業部 Discord サーバー（ギルド）ID
 *   DISCORD_PUBLIC_KEY   … Slash Command 署名検証用の公開鍵（任意）
 *   NOTIFY_CHANNEL_ID    … 部内お知らせチャンネルのID（遅延・投票の全体通知用）
 *   GOOGLE_BOOKS_API_KEY … Google Books API キー（任意・無くても動く）
 *   ADMIN_DISCORD_IDS    … 初期管理者の Discord ID（カンマ区切り・任意）
 *   WEBAPP_URL           … デプロイした Web App の /exec URL（OAuthリダイレクト用）
 */

const Config = (function () {
  const props = PropertiesService.getScriptProperties();

  function get(key, fallback) {
    const v = props.getProperty(key);
    return (v === null || v === undefined || v === '') ? (fallback || '') : v;
  }

  return {
    get: get,
    spreadsheetId:      function () { return get('SPREADSHEET_ID'); },
    discordClientId:    function () { return get('DISCORD_CLIENT_ID'); },
    discordClientSecret:function () { return get('DISCORD_CLIENT_SECRET'); },
    discordBotToken:    function () { return get('DISCORD_BOT_TOKEN'); },
    discordGuildId:     function () { return get('DISCORD_GUILD_ID'); },
    discordPublicKey:   function () { return get('DISCORD_PUBLIC_KEY'); },
    notifyChannelId:    function () { return get('NOTIFY_CHANNEL_ID'); },
    // Cloudflare Worker 中継を使う場合のベースURL（例: https://xxx.workers.dev）と共有シークレット
    discordProxyBase:   function () { return get('DISCORD_PROXY_BASE').replace(/\/+$/, ''); },
    discordProxySecret: function () { return get('DISCORD_PROXY_SECRET'); },
    googleBooksApiKey:  function () { return get('GOOGLE_BOOKS_API_KEY'); },
    webappUrl:          function () { return get('WEBAPP_URL') || ScriptApp.getService().getUrl(); },
    adminDiscordIds:    function () {
      return get('ADMIN_DISCORD_IDS').split(',').map(function (s) { return s.trim(); }).filter(String);
    },
  };
})();

// 貸出期間・ペナルティ等のビジネスルール定数
const Rules = {
  DEFAULT_LEND_DAYS: 14,        // 標準貸与期間
  LONG_BOOK_LEND_DAYS: 28,      // 300ページ以上
  LONG_BOOK_PAGE_THRESHOLD: 300,
  MAX_EXTENSIONS: 1,            // 延長は1回まで
  EXTENSION_DAYS: 14,           // 1回の延長で延びる日数
  PENALTY_BASE_DAYS: 3,         // ペナルティ基本停止日数
  PENALTY_STEP_DAYS: 2,         // 累積1回ごとに加算
  PENALTY_RESET_MONTHS: 3,      // ペナルティ回数リセット期間
  SESSION_TTL_SECONDS: 60 * 60 * 6, // セッション有効期限（6時間）
};

/* ======================================================================
 *  Utils / SheetDB
 * ==================================================================== */

/**
 * Utils.gs
 * 共通ユーティリティ + スプレッドシートをDBとして扱う薄いORM。
 *
 * Schema にシート名→カラム定義を集約し、各ドメインモジュール（Books.gs等）は
 * SheetDB.read / insert / update / remove だけを使えば良いようにする。
 */

// ─── スキーマ定義（仕様書のDB設計に対応） ──────────────────────────
const Schema = {
  books: [
    'book_id', 'title', 'author', 'publisher', 'isbn', 'cover_url',
    'page_count', 'condition', 'status', 'owner_id', 'external_link',
    'pending_enrichment', 'registered_at',
  ],
  members: [
    'member_id', 'discord_id', 'discord_username', 'avatar_url', 'role',
    'penalty_until', 'penalty_count', 'last_penalty_at', 'joined_at',
  ],
  lendings: [
    'lending_id', 'book_id', 'borrower_id', 'lent_at', 'due_date',
    'returned_at', 'extended', 'return_condition', 'status',
  ],
  waitlist: [
    'waitlist_id', 'book_id', 'member_id', 'registered_at', 'notified',
  ],
  reviews: [
    'review_id', 'book_id', 'member_id', 'stars', 'comment', 'read_timing',
    'recommended_chapter', 'for_whom', 'pair_book', 'applied_to', 'posted_at',
  ],
  tags: [
    'tag_id', 'name', 'created_by', 'created_at',
  ],
  book_tags: [
    'book_id', 'tag_id',
  ],
  requests: [
    'request_id', 'title', 'author', 'isbn', 'reason', 'requested_by',
    'status', 'vote_count', 'requested_at',
  ],
  request_votes: [
    'request_id', 'member_id', 'voted_at',
  ],
  forum_posts: [
    'post_id', 'book_id', 'member_id', 'content', 'posted_at',
  ],
  baton: [
    'baton_id', 'book_id', 'from_member_id', 'to_member_id', 'message', 'created_at',
  ],
  badges: [
    'badge_id', 'name', 'condition',
  ],
  member_badges: [
    'member_id', 'badge_id', 'earned_at',
  ],
  wishlists: [
    'wishlist_id', 'member_id', 'title', 'author', 'isbn', 'memo', 'created_at',
  ],
  penalty_log: [
    'penalty_id', 'member_id', 'lending_id', 'stop_days', 'penalty_at', 'expires_at',
  ],
  sessions: [
    'token', 'member_id', 'created_at', 'expires_at',
  ],
};

// boolean として扱うカラム（読み書き時に変換）
const BOOLEAN_COLUMNS = {
  pending_enrichment: true,
  extended: true,
  notified: true,
};

// number として扱うカラム
const NUMBER_COLUMNS = {
  page_count: true,
  stars: true,
  vote_count: true,
  penalty_count: true,
  stop_days: true,
};

// ─── 低レベルなスプレッドシートアクセス ───────────────────────────
const SheetDB = (function () {
  let _ss = null;

  function ss() {
    if (_ss) return _ss;
    const id = Config.spreadsheetId();
    _ss = id ? SpreadsheetApp.openById(id) : SpreadsheetApp.getActiveSpreadsheet();
    if (!_ss) throw new Error('スプレッドシートが見つかりません。SPREADSHEET_ID を設定してください。');
    return _ss;
  }

  function sheet(name) {
    const s = ss().getSheetByName(name);
    if (!s) throw new Error('シートが存在しません: ' + name + '（Setup.setup() を実行してください）');
    return s;
  }

  function headers(name) {
    return Schema[name] || sheet(name).getRange(1, 1, 1, sheet(name).getLastColumn())
      .getValues()[0].map(String);
  }

  function coerceOut(col, value) {
    // シート → JS。boolean / number / 空文字 を整える
    if (value === '' || value === null || value === undefined) {
      if (BOOLEAN_COLUMNS[col]) return false;
      return null;
    }
    if (BOOLEAN_COLUMNS[col]) return value === true || value === 'TRUE' || value === 'true';
    if (NUMBER_COLUMNS[col]) return Number(value) || 0;
    if (value instanceof Date) return value.toISOString();
    return value;
  }

  function coerceIn(col, value) {
    // JS → シート
    if (value === undefined || value === null) return '';
    if (BOOLEAN_COLUMNS[col]) return value === true || value === 'true' || value === 'TRUE';
    if (NUMBER_COLUMNS[col]) return (value === '' ? '' : Number(value));
    return value;
  }

  function rowToObj(name, row) {
    const cols = Schema[name];
    const obj = {};
    for (let i = 0; i < cols.length; i++) {
      obj[cols[i]] = coerceOut(cols[i], row[i]);
    }
    return obj;
  }

  function objToRow(name, obj) {
    const cols = Schema[name];
    return cols.map(function (c) { return coerceIn(c, obj[c]); });
  }

  /** 全行をオブジェクト配列で取得 */
  function read(name) {
    const s = sheet(name);
    const lastRow = s.getLastRow();
    if (lastRow < 2) return [];
    const cols = Schema[name];
    const values = s.getRange(2, 1, lastRow - 1, cols.length).getValues();
    return values.map(function (row) { return rowToObj(name, row); });
  }

  /** 条件に合う最初の1件 */
  function find(name, predicate) {
    const rows = read(name);
    for (let i = 0; i < rows.length; i++) {
      if (predicate(rows[i])) return rows[i];
    }
    return null;
  }

  /** 条件に合う全件 */
  function filter(name, predicate) {
    return read(name).filter(predicate);
  }

  /** 1行追記 */
  function insert(name, obj) {
    const s = sheet(name);
    s.appendRow(objToRow(name, obj));
    return obj;
  }

  /**
   * idField === idValue の行を patch で更新。
   * 戻り値は更新後オブジェクト、見つからなければ null。
   */
  function update(name, idField, idValue, patch) {
    const s = sheet(name);
    const lastRow = s.getLastRow();
    if (lastRow < 2) return null;
    const cols = Schema[name];
    const idx = cols.indexOf(idField);
    if (idx < 0) throw new Error('不正なidField: ' + idField);

    const range = s.getRange(2, 1, lastRow - 1, cols.length);
    const values = range.getValues();
    for (let r = 0; r < values.length; r++) {
      if (String(values[r][idx]) === String(idValue)) {
        const current = rowToObj(name, values[r]);
        const merged = Object.assign({}, current, patch);
        s.getRange(r + 2, 1, 1, cols.length).setValues([objToRow(name, merged)]);
        return merged;
      }
    }
    return null;
  }

  /** 条件に合う行を全削除。削除件数を返す */
  function remove(name, predicate) {
    const s = sheet(name);
    const lastRow = s.getLastRow();
    if (lastRow < 2) return 0;
    const cols = Schema[name];
    const values = s.getRange(2, 1, lastRow - 1, cols.length).getValues();
    let removed = 0;
    // 下から削除して行ズレを防ぐ
    for (let r = values.length - 1; r >= 0; r--) {
      if (predicate(rowToObj(name, values[r]))) {
        s.deleteRow(r + 2);
        removed++;
      }
    }
    return removed;
  }

  return {
    ss: ss,
    sheet: sheet,
    headers: headers,
    read: read,
    find: find,
    filter: filter,
    insert: insert,
    update: update,
    remove: remove,
  };
})();

// ─── 汎用ヘルパー ─────────────────────────────────────────────────
const Utils = {
  uuid: function () { return Utilities.getUuid(); },

  now: function () { return new Date(); },

  /** Date or null を ISO文字列 or null に */
  iso: function (d) {
    if (!d) return null;
    if (d instanceof Date) return d.toISOString();
    return d;
  },

  /** 文字列/Date を Date に。失敗時 null */
  parseDate: function (v) {
    if (!v) return null;
    if (v instanceof Date) return v;
    const d = new Date(v);
    return isNaN(d.getTime()) ? null : d;
  },

  addDays: function (date, days) {
    const d = new Date(date.getTime());
    d.setDate(d.getDate() + days);
    return d;
  },

  addMonths: function (date, months) {
    const d = new Date(date.getTime());
    d.setMonth(d.getMonth() + months);
    return d;
  },

  /** 2つの日付の差（日数・切り捨て） */
  daysBetween: function (a, b) {
    return Math.floor((b.getTime() - a.getTime()) / (1000 * 60 * 60 * 24));
  },

  /** 同じ日（年月日）か */
  isSameDay: function (a, b) {
    return a.getFullYear() === b.getFullYear()
      && a.getMonth() === b.getMonth()
      && a.getDate() === b.getDate();
  },

  /** 日本語の日付表記 yyyy/MM/dd */
  fmtDate: function (d) {
    if (!d) return '';
    const date = (d instanceof Date) ? d : new Date(d);
    return Utilities.formatDate(date, 'Asia/Tokyo', 'yyyy/MM/dd');
  },

  isbnNormalize: function (isbn) {
    return String(isbn || '').replace(/[^0-9Xx]/g, '');
  },
};

/* ======================================================================
 *  Setup
 * ==================================================================== */

/**
 * Setup.gs
 * 初期セットアップ用。GASエディタから setup() を一度実行すると、
 * DB用スプレッドシートを用意し、Schema 定義に従って全シートを作成し、
 * 初期タグ・初期バッジを投入する。
 */

function setup() {
  const ss = resolveOrCreateSpreadsheet();

  // 各シートを作成し、ヘッダー行を整える
  Object.keys(Schema).forEach(function (name) {
    let sheet = ss.getSheetByName(name);
    if (!sheet) sheet = ss.insertSheet(name);
    const cols = Schema[name];
    const headerRange = sheet.getRange(1, 1, 1, cols.length);
    headerRange.setValues([cols]);
    headerRange.setFontWeight('bold').setBackground('#e0eaff');
    sheet.setFrozenRows(1);
  });

  // デフォルトの "シート1" が残っていたら削除
  const def = ss.getSheetByName('シート1') || ss.getSheetByName('Sheet1');
  if (def && ss.getSheets().length > 1) {
    try { ss.deleteSheet(def); } catch (e) { /* ignore */ }
  }

  seedTags();
  seedBadges();
  seedAdmins();

  const url = ss.getUrl();
  Logger.log('セットアップ完了。Spreadsheet: ' + url);
  Logger.log('SPREADSHEET_ID = ' + ss.getId() + '（スクリプトプロパティに保存済み）');
  return 'OK / ' + url;
}

/**
 * 表紙解決の動作確認。GASエディタで実行し、ログの cover_url を見る。
 * - cover.openbd.jp / books.google なら最新コード（正常）
 * - ndlsearch.ndl.go.jp/thumbnail なら「保存中のコードが旧版」→ Domain.gs を貼り直す
 * 実行できるのは保存中(HEAD)のコードなので、ここが正常でも /exec が古い場合は
 * 「デプロイ → デプロイを管理 → 編集 → 新バージョン」で再デプロイが必要。
 */
function testCoverLookup() {
  const isbn = '9784297154363';
  const meta = Books.lookupIsbn(isbn);
  Logger.log('lookupIsbn(' + isbn + ') = ' + JSON.stringify(meta));
  return meta;
}

/**
 * 壊れた表紙URL（旧NDLサムネイル等）を一括修復する保守用関数。
 * 表紙が空 or NDLサムネイルURLの本について、ISBNから openBD/Google で再解決する。
 * GASエディタから手動実行する。
 */
function fixBrokenCovers() {
  let fixed = 0, checked = 0;
  SheetDB.read('books').forEach(function (b) {
    if (!b.isbn) return;
    const broken = !b.cover_url || b.cover_url.indexOf('ndlsearch.ndl.go.jp/thumbnail') >= 0;
    if (!broken) return;
    checked++;
    const cover = Books.resolveCover(b.isbn);
    if (cover && cover !== b.cover_url) {
      SheetDB.update('books', 'book_id', b.book_id, { cover_url: cover });
      fixed++;
    }
  });
  Logger.log('表紙修復: 対象' + checked + '件中 ' + fixed + '件を更新しました。');
  return '対象' + checked + '件 / 更新' + fixed + '件';
}

/**
 * DB用スプレッドシートを解決する。優先順位:
 *   1. スクリプトプロパティ SPREADSHEET_ID があれば openById
 *   2. コンテナバインド時はアクティブなスプレッドシート（IDを保存）
 *   3. どちらも無ければ新規スプレッドシートを作成（IDを保存）
 * いずれの場合も最終的に SPREADSHEET_ID をスクリプトプロパティへ書き込むので、
 * Web App デプロイ後（getActiveSpreadsheet が使えない文脈）でも openById で参照できる。
 */
function resolveOrCreateSpreadsheet() {
  const props = PropertiesService.getScriptProperties();
  const id = props.getProperty('SPREADSHEET_ID');
  if (id) return SpreadsheetApp.openById(id);

  let ss = null;
  try { ss = SpreadsheetApp.getActiveSpreadsheet(); } catch (e) { ss = null; }
  if (!ss) {
    ss = SpreadsheetApp.create('BOMUbrary DB');
  }
  props.setProperty('SPREADSHEET_ID', ss.getId());
  return ss;
}

/** 初期タグ（仕様書の初期タグ例） */
function seedTags() {
  if (SheetDB.read('tags').length > 0) return;
  const initial = [
    '起業', 'マーケ', '技術', '思想', '組織', 'ファイナンス', '営業', 'デザイン',
    'アイデア期', '開発中', 'PMF', '営業中', '資金調達', 'スケール期',
    '通読向け', 'ななめ読みOK', '辞書的に使う', '課題図書',
    '入門', '中級', '上級',
    '1日で読める', '1週間目安', 'じっくり系',
  ];
  initial.forEach(function (name) {
    SheetDB.insert('tags', {
      tag_id: Utils.uuid(),
      name: name,
      created_by: 'system',
      created_at: Utils.now(),
    });
  });
}

/** 初期バッジ（仕様書の読書バッジ） */
function seedBadges() {
  if (SheetDB.read('badges').length > 0) return;
  const badges = [
    ['初借り', '初めて本を借りる'],
    ['初レビュー', '初めてレビューを書く'],
    ['タグ職人', 'タグを5個以上新規作成する'],
    ['バトンの達人', 'バトンリレーを5回以上実施'],
    ['蔵書貢献者', '部の蔵書に3冊以上登録'],
    ['リクエスター', '購入リクエストが購入済みになる'],
    ['皆勤返却', '遅延ゼロで10冊返却'],
    ['読書会常連', '読書会スレッドに10回以上投稿'],
    ['読破王', '読了マークを20冊以上つける'],
  ];
  badges.forEach(function (b) {
    SheetDB.insert('badges', {
      badge_id: b[0],            // 安定したキーとして名前ベースのIDを使う
      name: b[0],
      condition: b[1],
    });
  });
}

/** ADMIN_DISCORD_IDS に列挙された Discord ID を管理者として members に登録 */
function seedAdmins() {
  const ids = Config.adminDiscordIds();
  ids.forEach(function (discordId) {
    const existing = SheetDB.find('members', function (m) { return m.discord_id === discordId; });
    if (existing) {
      if (existing.role !== 'admin') {
        SheetDB.update('members', 'member_id', existing.member_id, { role: 'admin' });
      }
      return;
    }
    SheetDB.insert('members', {
      member_id: Utils.uuid(),
      discord_id: discordId,
      discord_username: '(管理者)',
      avatar_url: '',
      role: 'admin',
      penalty_until: '',
      penalty_count: 0,
      last_penalty_at: '',
      joined_at: Utils.now(),
    });
  });
}
