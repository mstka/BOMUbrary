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
