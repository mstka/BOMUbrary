/**
 * Members.gs
 * メンバー情報・マイページ・ウィッシュリスト。
 */

const Members = (function () {

  /** クライアントに返してよい公開プロフィール */
  function toPublic(member) {
    if (!member) return null;
    const penaltyUntil = Utils.parseDate(member.penalty_until);
    const onPenalty = !!(penaltyUntil && penaltyUntil.getTime() > Date.now());
    return {
      member_id: member.member_id,
      discord_id: member.discord_id,
      discord_username: member.discord_username,
      avatar_url: member.avatar_url,
      role: member.role,
      penalty_until: onPenalty ? Utils.iso(penaltyUntil) : null,
      on_penalty: onPenalty,
    };
  }

  function byId(memberId) {
    return SheetDB.find('members', function (m) { return m.member_id === memberId; });
  }

  function listPublic() {
    return SheetDB.read('members').map(toPublic);
  }

  /** member_id → 表示名のマップ（一覧表示でのN+1回避用） */
  function nameMap() {
    const map = {};
    SheetDB.read('members').forEach(function (m) {
      map[m.member_id] = m.discord_username;
    });
    return map;
  }

  function myPage(member) {
    const names = nameMap();
    const allLendings = SheetDB.filter('lendings', function (l) {
      return l.borrower_id === member.member_id;
    });

    // 借り中（未返却）
    const borrowing = allLendings
      .filter(function (l) { return !l.returned_at; })
      .map(function (l) {
        const book = Books.raw(l.book_id);
        return {
          lending_id: l.lending_id,
          book_id: l.book_id,
          title: book ? book.title : '(削除済み)',
          cover_url: book ? book.cover_url : '',
          due_date: Utils.iso(Utils.parseDate(l.due_date)),
          extended: l.extended,
          status: l.status,
          overdue: isOverdue(l),
        };
      });

    // 読了リスト（読了マーク済み = status 'read'）
    const readList = allLendings
      .filter(function (l) { return l.status === 'read'; })
      .map(function (l) {
        const book = Books.raw(l.book_id);
        return {
          book_id: l.book_id,
          title: book ? book.title : '(削除済み)',
          cover_url: book ? book.cover_url : '',
          returned_at: Utils.iso(Utils.parseDate(l.returned_at)),
        };
      });

    // 自分が登録した本
    const ownedBooks = SheetDB.filter('books', function (b) {
      return b.owner_id === member.member_id;
    }).map(Books.toCard);

    // バッジ
    const badgeDefs = {};
    SheetDB.read('badges').forEach(function (b) { badgeDefs[b.badge_id] = b; });
    const badges = SheetDB.filter('member_badges', function (mb) {
      return mb.member_id === member.member_id;
    }).map(function (mb) {
      const def = badgeDefs[mb.badge_id] || {};
      return {
        badge_id: mb.badge_id,
        name: def.name || mb.badge_id,
        condition: def.condition || '',
        earned_at: Utils.iso(Utils.parseDate(mb.earned_at)),
      };
    });

    // ウィッシュリスト
    const wishlist = SheetDB.filter('wishlists', function (w) {
      return w.member_id === member.member_id;
    }).map(function (w) {
      return {
        wishlist_id: w.wishlist_id,
        title: w.title,
        author: w.author,
        isbn: w.isbn,
        memo: w.memo,
      };
    });

    return {
      profile: toPublic(member),
      borrowing: borrowing,
      readList: readList,
      ownedBooks: ownedBooks,
      badges: badges,
      wishlist: wishlist,
    };
  }

  function isOverdue(lending) {
    if (lending.returned_at) return false;
    const due = Utils.parseDate(lending.due_date);
    return !!(due && due.getTime() < Date.now());
  }

  function addWishlist(member, payload) {
    const item = {
      wishlist_id: Utils.uuid(),
      member_id: member.member_id,
      title: (payload.title || '').trim(),
      author: (payload.author || '').trim(),
      isbn: Utils.isbnNormalize(payload.isbn),
      memo: (payload.memo || '').trim(),
      created_at: Utils.now(),
    };
    if (!item.title) throw new Error('タイトルは必須です。');
    SheetDB.insert('wishlists', item);
    return { ok: true, wishlist_id: item.wishlist_id };
  }

  function removeWishlist(member, wishlistId) {
    const removed = SheetDB.remove('wishlists', function (w) {
      return w.wishlist_id === wishlistId && w.member_id === member.member_id;
    });
    return { ok: removed > 0 };
  }

  return {
    toPublic: toPublic,
    byId: byId,
    listPublic: listPublic,
    nameMap: nameMap,
    myPage: myPage,
    isOverdue: isOverdue,
    addWishlist: addWishlist,
    removeWishlist: removeWishlist,
  };
})();
