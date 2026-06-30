/**
 * Baton.gs
 * バトンリレー（返却時に次の読み手を指名）。
 */

const Baton = (function () {

  function listByBook(bookId) {
    const names = Members.nameMap();
    return SheetDB.filter('baton', function (b) { return b.book_id === bookId; })
      .sort(function (a, b) { return new Date(b.created_at) - new Date(a.created_at); })
      .map(function (b) {
        return {
          baton_id: b.baton_id,
          from_name: names[b.from_member_id] || '',
          to_name: names[b.to_member_id] || '',
          message: b.message,
          created_at: Utils.iso(Utils.parseDate(b.created_at)),
        };
      });
  }

  function pass(member, bookId, toMemberId, message) {
    const book = Books.raw(bookId);
    if (!book) throw new Error('本が見つかりません。');
    if (toMemberId === member.member_id) throw new Error('自分自身は指名できません。');
    const to = Members.byId(toMemberId);
    if (!to) throw new Error('指名先のメンバーが見つかりません。');

    const baton = {
      baton_id: Utils.uuid(),
      book_id: bookId,
      from_member_id: member.member_id,
      to_member_id: toMemberId,
      message: (message || '').trim(),
      created_at: Utils.now(),
    };
    SheetDB.insert('baton', baton);

    Discord.notifyMember(toMemberId,
      '🎌 **バトンリレー指名**\n' + member.discord_username + ' さんから「' + book.title + '」を勧められました。'
      + (baton.message ? '\n💬 ' + baton.message : '') + '\n'
      + Config.webappUrl() + '#/detail?book=' + bookId);

    Badges.checkForMember(member.member_id); // バトンの達人
    return { ok: true, baton_id: baton.baton_id };
  }

  return {
    listByBook: listByBook,
    pass: pass,
  };
})();
