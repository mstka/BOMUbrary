/**
 * Admin.gs
 * 管理機能（蔵書統計・遅延者管理・メンバー管理）。
 */

const Admin = (function () {

  function stats() {
    const books = SheetDB.read('books');
    const lendings = SheetDB.read('lendings');
    const lendingCount = books.filter(function (b) { return b.status === 'lending'; }).length;

    // 人気本ランキング（貸出回数）
    const lentTimes = {};
    lendings.forEach(function (l) {
      if (l.lent_at) lentTimes[l.book_id] = (lentTimes[l.book_id] || 0) + 1;
    });
    const titles = {};
    books.forEach(function (b) { titles[b.book_id] = b.title; });
    const ranking = Object.keys(lentTimes)
      .map(function (id) { return { book_id: id, title: titles[id] || '(削除済み)', count: lentTimes[id] }; })
      .sort(function (a, b) { return b.count - a.count; })
      .slice(0, 10);

    return {
      totalBooks: books.length,
      lendingCount: lendingCount,
      availableCount: books.filter(function (b) { return b.status === 'available'; }).length,
      lendingRate: books.length ? Math.round((lendingCount / books.length) * 100) : 0,
      memberCount: SheetDB.read('members').length,
      ranking: ranking,
    };
  }

  function overdueList() {
    const names = Members.nameMap();
    const titles = {};
    SheetDB.read('books').forEach(function (b) { titles[b.book_id] = b.title; });
    const now = Date.now();
    return SheetDB.filter('lendings', function (l) {
      if (l.returned_at) return false;
      const due = Utils.parseDate(l.due_date);
      return due && due.getTime() < now;
    }).map(function (l) {
      const due = Utils.parseDate(l.due_date);
      return {
        lending_id: l.lending_id,
        book_title: titles[l.book_id] || '(削除済み)',
        borrower_id: l.borrower_id,
        borrower_name: names[l.borrower_id] || '',
        due_date: Utils.iso(due),
        days_overdue: Utils.daysBetween(due, new Date()),
      };
    }).sort(function (a, b) { return b.days_overdue - a.days_overdue; });
  }

  function addMember(discordId, username, role) {
    const id = String(discordId || '').trim();
    if (!id) throw new Error('Discord ID は必須です。');
    const existing = SheetDB.find('members', function (m) { return m.discord_id === id; });
    if (existing) throw new Error('すでに登録済みのメンバーです。');

    SheetDB.insert('members', {
      member_id: Utils.uuid(),
      discord_id: id,
      discord_username: (username || '(未ログイン)').trim(),
      avatar_url: '',
      role: role === 'admin' ? 'admin' : 'member',
      penalty_until: '',
      penalty_count: 0,
      last_penalty_at: '',
      joined_at: Utils.now(),
    });
    return { ok: true };
  }

  function removeMember(memberId) {
    const member = Members.byId(memberId);
    if (!member) throw new Error('メンバーが見つかりません。');
    const active = SheetDB.find('lendings', function (l) {
      return l.borrower_id === memberId && !l.returned_at && l.status !== 'requested';
    });
    if (active) throw new Error('貸出中の本があるメンバーは削除できません。');
    SheetDB.remove('members', function (m) { return m.member_id === memberId; });
    return { ok: true };
  }

  return {
    stats: stats,
    overdueList: overdueList,
    addMember: addMember,
    removeMember: removeMember,
  };
})();
