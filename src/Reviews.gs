/**
 * Reviews.gs
 * レビュー・読み方ガイド（星評価とひとこと感想が必須）。
 */

const Reviews = (function () {

  function listByBook(bookId) {
    const names = Members.nameMap();
    const avatars = {};
    SheetDB.read('members').forEach(function (m) { avatars[m.member_id] = m.avatar_url; });
    return SheetDB.filter('reviews', function (r) { return r.book_id === bookId; })
      .sort(function (a, b) { return new Date(b.posted_at) - new Date(a.posted_at); })
      .map(function (r) {
        return {
          review_id: r.review_id,
          member_name: names[r.member_id] || '',
          avatar_url: avatars[r.member_id] || '',
          stars: r.stars,
          comment: r.comment,
          read_timing: r.read_timing,
          recommended_chapter: r.recommended_chapter,
          for_whom: r.for_whom,
          pair_book: r.pair_book,
          applied_to: r.applied_to,
          posted_at: Utils.iso(Utils.parseDate(r.posted_at)),
        };
      });
  }

  function post(member, payload) {
    const stars = Number(payload.stars);
    if (!(stars >= 1 && stars <= 5)) throw new Error('星評価（1〜5）は必須です。');
    const comment = (payload.comment || '').trim();
    if (!comment) throw new Error('ひとこと感想は必須です。');
    if (!payload.book_id || !Books.raw(payload.book_id)) throw new Error('対象の本が見つかりません。');

    const review = {
      review_id: Utils.uuid(),
      book_id: payload.book_id,
      member_id: member.member_id,
      stars: stars,
      comment: comment,
      read_timing: (payload.read_timing || '').trim(),
      recommended_chapter: (payload.recommended_chapter || '').trim(),
      for_whom: (payload.for_whom || '').trim(),
      pair_book: (payload.pair_book || '').trim(),
      applied_to: (payload.applied_to || '').trim(),
      posted_at: Utils.now(),
    };
    SheetDB.insert('reviews', review);
    Badges.checkForMember(member.member_id); // 初レビュー
    return { ok: true, review_id: review.review_id };
  }

  /** 本ごとの平均評価・件数（一覧の概要表示用） */
  function summary(bookId) {
    const rs = SheetDB.filter('reviews', function (r) { return r.book_id === bookId; });
    if (!rs.length) return { count: 0, avg: 0 };
    const total = rs.reduce(function (s, r) { return s + (r.stars || 0); }, 0);
    return { count: rs.length, avg: Math.round((total / rs.length) * 10) / 10 };
  }

  return {
    listByBook: listByBook,
    post: post,
    summary: summary,
  };
})();
