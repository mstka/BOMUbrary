/**
 * Lendings.gs
 * 貸出申請・承認・返却・延長・待ちリスト・読了マーク。
 *
 * lendings.status の遷移:
 *   requested → active → (extension_requested) → active → returned → read
 */

const Lendings = (function () {

  function byId(lendingId) {
    return SheetDB.find('lendings', function (l) { return l.lending_id === lendingId; });
  }

  function activeForBook(bookId) {
    return SheetDB.find('lendings', function (l) {
      return l.book_id === bookId && !l.returned_at && l.status !== 'requested';
    });
  }

  function assertNotPenalized(member) {
    const until = Utils.parseDate(member.penalty_until);
    if (until && until.getTime() > Date.now()) {
      throw new Error(Utils.fmtDate(until) + ' まで借出停止中です。');
    }
  }

  // ─── 貸出申請 ────────────────────────────────────────────────────
  function requestLend(member, bookId) {
    assertNotPenalized(member);
    const book = Books.raw(bookId);
    if (!book) throw new Error('本が見つかりません。');
    if (book.owner_id === member.member_id) throw new Error('自分の本は借りられません。');

    const active = activeForBook(bookId);
    if (active) {
      throw new Error('現在貸出中です。待ちリストに登録してください。');
    }
    // 既に申請済みなら二重申請を防ぐ
    const dup = SheetDB.find('lendings', function (l) {
      return l.book_id === bookId && l.borrower_id === member.member_id && l.status === 'requested';
    });
    if (dup) throw new Error('すでに申請済みです。オーナーの承認をお待ちください。');

    const lending = {
      lending_id: Utils.uuid(),
      book_id: bookId,
      borrower_id: member.member_id,
      lent_at: '',
      due_date: '',
      returned_at: '',
      extended: false,
      return_condition: '',
      status: 'requested',
    };
    SheetDB.insert('lendings', lending);

    // オーナーへ申請通知
    Discord.notifyMember(book.owner_id,
      '📚 **貸出申請**\n' + member.discord_username + ' さんが「' + book.title + '」を借りたいと言っています。\n'
      + Config.webappUrl() + '#/detail?book=' + bookId);

    return { ok: true, lending_id: lending.lending_id };
  }

  // ─── 貸出承認（オーナー） ─────────────────────────────────────────
  function approveLend(owner, bookId, borrowerId) {
    const book = Books.raw(bookId);
    if (!book) throw new Error('本が見つかりません。');
    if (book.owner_id !== owner.member_id && owner.role !== 'admin') {
      throw new Error('この本のオーナーのみ承認できます。');
    }
    if (activeForBook(bookId)) throw new Error('すでに貸出中です。');

    const lending = SheetDB.find('lendings', function (l) {
      return l.book_id === bookId && l.borrower_id === borrowerId && l.status === 'requested';
    });
    if (!lending) throw new Error('対象の貸出申請が見つかりません。');

    const borrower = Members.byId(borrowerId);
    assertNotPenalized(borrower);

    const now = Utils.now();
    const due = Utils.addDays(now, Books.lendDays(book));
    SheetDB.update('lendings', 'lending_id', lending.lending_id, {
      lent_at: now,
      due_date: due,
      status: 'active',
    });
    Books.setStatus(bookId, 'lending');

    // この本への他の申請を却下
    SheetDB.filter('lendings', function (l) {
      return l.book_id === bookId && l.status === 'requested' && l.lending_id !== lending.lending_id;
    }).forEach(function (l) {
      SheetDB.remove('lendings', function (x) { return x.lending_id === l.lending_id; });
      Discord.notifyMember(l.borrower_id,
        '「' + book.title + '」は他の方への貸出が決まりました。待ちリストに登録できます。');
    });

    // 借り手へ通知 + バッジ判定（初借り）
    Discord.notifyMember(borrowerId,
      '✅ **貸出承認**\n「' + book.title + '」を借りられます。返却期限は ' + Utils.fmtDate(due) + ' です。');
    Badges.checkForMember(borrowerId);

    return { ok: true, due_date: Utils.iso(due) };
  }

  // ─── 返却 ────────────────────────────────────────────────────────
  function returnBook(member, lendingId, condition) {
    const lending = byId(lendingId);
    if (!lending) throw new Error('貸出記録が見つかりません。');
    if (lending.returned_at) throw new Error('すでに返却済みです。');
    const book = Books.raw(lending.book_id);
    const isBorrower = lending.borrower_id === member.member_id;
    const isOwner = book && book.owner_id === member.member_id;
    if (!isBorrower && !isOwner && member.role !== 'admin') {
      throw new Error('返却を報告する権限がありません。');
    }

    const now = Utils.now();
    SheetDB.update('lendings', 'lending_id', lendingId, {
      returned_at: now,
      return_condition: condition || '',
      status: 'returned',
    });

    // 遅延ならペナルティ
    const due = Utils.parseDate(lending.due_date);
    if (due && now.getTime() > due.getTime() && Utils.daysBetween(due, now) >= 1) {
      Penalty.apply(lending.borrower_id, lendingId);
    }

    // 待ちリストの先頭へ通知 or 在庫を空きに
    const nextNotified = notifyNextInWaitlist(book);
    if (!nextNotified) Books.setStatus(lending.book_id, 'available');

    Badges.checkForMember(lending.borrower_id); // 皆勤返却など
    return { ok: true, readable: true };
  }

  /** 待ちリスト先頭に「借りられます」通知。通知したら true */
  function notifyNextInWaitlist(book) {
    if (!book) return false;
    const queue = SheetDB.filter('waitlist', function (w) { return w.book_id === book.book_id; })
      .sort(function (a, b) { return new Date(a.registered_at) - new Date(b.registered_at); });
    const next = queue.filter(function (w) { return !w.notified; })[0];
    if (!next) return false;

    SheetDB.update('waitlist', 'waitlist_id', next.waitlist_id, { notified: true });
    Discord.notifyMember(next.member_id,
      '🔔 **順番が来ました**\n「' + book.title + '」が返却されました。借りますか？\n'
      + Config.webappUrl() + '#/detail?book=' + book.book_id);
    return true;
  }

  // ─── 延長申請 ────────────────────────────────────────────────────
  function requestExtension(member, lendingId) {
    const lending = byId(lendingId);
    if (!lending) throw new Error('貸出記録が見つかりません。');
    if (lending.borrower_id !== member.member_id) throw new Error('借りている本人のみ延長申請できます。');
    if (lending.returned_at) throw new Error('返却済みです。');
    if (lending.extended) throw new Error('延長は1回までです。');

    const waiting = SheetDB.find('waitlist', function (w) { return w.book_id === lending.book_id; });
    if (waiting) throw new Error('待ちリストに登録者がいるため延長できません。');

    SheetDB.update('lendings', 'lending_id', lendingId, { status: 'extension_requested' });

    const book = Books.raw(lending.book_id);
    Discord.notifyMember(book.owner_id,
      '⏳ **延長申請**\n' + member.discord_username + ' さんが「' + book.title + '」の延長を希望しています。\n'
      + '承認/拒否: ' + Config.webappUrl() + '#/detail?book=' + lending.book_id);
    return { ok: true };
  }

  function decideExtension(owner, lendingId, approve) {
    const lending = byId(lendingId);
    if (!lending) throw new Error('貸出記録が見つかりません。');
    const book = Books.raw(lending.book_id);
    if (!book || (book.owner_id !== owner.member_id && owner.role !== 'admin')) {
      throw new Error('オーナーのみ延長を承認できます。');
    }
    if (lending.status !== 'extension_requested') throw new Error('延長申請中ではありません。');

    if (approve) {
      const baseDue = Utils.parseDate(lending.due_date) || Utils.now();
      const newDue = Utils.addDays(baseDue, Rules.EXTENSION_DAYS);
      SheetDB.update('lendings', 'lending_id', lendingId, {
        due_date: newDue, extended: true, status: 'active',
      });
      Discord.notifyMember(lending.borrower_id,
        '✅ 「' + book.title + '」の延長が承認されました。新しい返却期限は ' + Utils.fmtDate(newDue) + ' です。');
      return { ok: true, due_date: Utils.iso(newDue) };
    } else {
      SheetDB.update('lendings', 'lending_id', lendingId, { status: 'active' });
      Discord.notifyMember(lending.borrower_id,
        '❌ 「' + book.title + '」の延長申請は承認されませんでした。');
      return { ok: true };
    }
  }

  // ─── 待ちリスト ──────────────────────────────────────────────────
  function joinWaitlist(member, bookId) {
    const book = Books.raw(bookId);
    if (!book) throw new Error('本が見つかりません。');
    const dup = SheetDB.find('waitlist', function (w) {
      return w.book_id === bookId && w.member_id === member.member_id;
    });
    if (dup) throw new Error('すでに待ちリストに登録済みです。');

    SheetDB.insert('waitlist', {
      waitlist_id: Utils.uuid(),
      book_id: bookId,
      member_id: member.member_id,
      registered_at: Utils.now(),
      notified: false,
    });
    return { ok: true };
  }

  function leaveWaitlist(member, bookId) {
    const removed = SheetDB.remove('waitlist', function (w) {
      return w.book_id === bookId && w.member_id === member.member_id;
    });
    return { ok: removed > 0 };
  }

  // ─── 読了マーク（返却確認後のみ） ─────────────────────────────────
  function markAsRead(member, lendingId) {
    const lending = byId(lendingId);
    if (!lending) throw new Error('貸出記録が見つかりません。');
    if (lending.borrower_id !== member.member_id) throw new Error('借りた本人のみ読了マークを付けられます。');
    if (!lending.returned_at) throw new Error('返却確認後にのみ読了マークを付けられます。');
    if (lending.status === 'read') return { ok: true, already: true };

    SheetDB.update('lendings', 'lending_id', lendingId, { status: 'read' });
    Badges.checkForMember(member.member_id); // 読破王
    return { ok: true };
  }

  return {
    byId: byId,
    requestLend: requestLend,
    approveLend: approveLend,
    returnBook: returnBook,
    notifyNextInWaitlist: notifyNextInWaitlist,
    requestExtension: requestExtension,
    decideExtension: decideExtension,
    joinWaitlist: joinWaitlist,
    leaveWaitlist: leaveWaitlist,
    markAsRead: markAsRead,
  };
})();
