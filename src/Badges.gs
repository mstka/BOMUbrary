/**
 * Badges.gs
 * 読書バッジの判定・付与。
 * checkForMember を各アクション後に呼べば、条件を満たした時点で付与される。
 */

const Badges = (function () {

  /** あるメンバーが既に取得済みのバッジID集合 */
  function ownedSet(memberId) {
    const set = {};
    SheetDB.filter('member_badges', function (mb) { return mb.member_id === memberId; })
      .forEach(function (mb) { set[mb.badge_id] = true; });
    return set;
  }

  function award(memberId, badgeId) {
    SheetDB.insert('member_badges', {
      member_id: memberId,
      badge_id: badgeId,
      earned_at: Utils.now(),
    });
    Discord.notifyMember(memberId, '🏅 **バッジ獲得！**「' + badgeId + '」を獲得しました！');
  }

  /** メンバーの各種カウントを集計 */
  function metrics(memberId) {
    const lendings = SheetDB.filter('lendings', function (l) { return l.borrower_id === memberId; });
    const borrowed = lendings.filter(function (l) { return !!l.lent_at; });
    const returned = lendings.filter(function (l) { return !!l.returned_at; });
    const overdueReturns = returned.filter(function (l) {
      const due = Utils.parseDate(l.due_date);
      const ret = Utils.parseDate(l.returned_at);
      return due && ret && ret.getTime() > due.getTime() && Utils.daysBetween(due, ret) >= 1;
    });
    const readMarks = lendings.filter(function (l) { return l.status === 'read'; });

    return {
      borrowedCount: borrowed.length,
      returnedCount: returned.length,
      overdueCount: overdueReturns.length,
      readCount: readMarks.length,
      reviewCount: SheetDB.filter('reviews', function (r) { return r.member_id === memberId; }).length,
      tagCount: SheetDB.filter('tags', function (t) { return t.created_by === memberId; }).length,
      batonCount: SheetDB.filter('baton', function (b) { return b.from_member_id === memberId; }).length,
      ownedBookCount: SheetDB.filter('books', function (b) { return b.owner_id === memberId; }).length,
      forumCount: SheetDB.filter('forum_posts', function (p) { return p.member_id === memberId; }).length,
      purchasedRequests: SheetDB.filter('requests', function (r) {
        return r.requested_by === memberId && r.status === 'purchased';
      }).length,
    };
  }

  /** 条件定義: badgeId → (metrics) => boolean */
  const CONDITIONS = {
    '初借り':       function (m) { return m.borrowedCount >= 1; },
    '初レビュー':   function (m) { return m.reviewCount >= 1; },
    'タグ職人':     function (m) { return m.tagCount >= 5; },
    'バトンの達人': function (m) { return m.batonCount >= 5; },
    '蔵書貢献者':   function (m) { return m.ownedBookCount >= 3; },
    'リクエスター': function (m) { return m.purchasedRequests >= 1; },
    '皆勤返却':     function (m) { return m.returnedCount >= 10 && m.overdueCount === 0; },
    '読書会常連':   function (m) { return m.forumCount >= 10; },
    '読破王':       function (m) { return m.readCount >= 20; },
  };

  /** 1人分の判定・付与 */
  function checkForMember(memberId) {
    if (!memberId) return [];
    const owned = ownedSet(memberId);
    const m = metrics(memberId);
    const newly = [];
    Object.keys(CONDITIONS).forEach(function (badgeId) {
      if (owned[badgeId]) return;
      // badges シートに定義が無い場合はスキップ
      try {
        if (CONDITIONS[badgeId](m)) {
          award(memberId, badgeId);
          newly.push(badgeId);
        }
      } catch (e) { /* ignore */ }
    });
    return newly;
  }

  /** 全員分の判定（cron 毎日 0:00） */
  function checkAll() {
    let total = 0;
    SheetDB.read('members').forEach(function (m) {
      total += checkForMember(m.member_id).length;
    });
    return total;
  }

  return {
    checkForMember: checkForMember,
    checkAll: checkAll,
  };
})();
