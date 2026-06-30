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
