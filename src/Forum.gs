/**
 * Forum.gs
 * 読書会スレッド（本ごと）。書き込みは「返却確認後に読了マークが付いた人」のみ。
 */

const Forum = (function () {

  /** その本を読了済みか（読了マーク = lendings.status 'read'） */
  function hasReadBook(memberId, bookId) {
    return !!SheetDB.find('lendings', function (l) {
      return l.book_id === bookId && l.borrower_id === memberId && l.status === 'read';
    });
  }

  function listByBook(bookId) {
    const names = Members.nameMap();
    const avatars = {};
    SheetDB.read('members').forEach(function (m) { avatars[m.member_id] = m.avatar_url; });
    return SheetDB.filter('forum_posts', function (p) { return p.book_id === bookId; })
      .sort(function (a, b) { return new Date(a.posted_at) - new Date(b.posted_at); })
      .map(function (p) {
        return {
          post_id: p.post_id,
          member_id: p.member_id,
          member_name: names[p.member_id] || '',
          avatar_url: avatars[p.member_id] || '',
          content: p.content,
          posted_at: Utils.iso(Utils.parseDate(p.posted_at)),
        };
      });
  }

  function post(member, bookId, contentRaw) {
    const book = Books.raw(bookId);
    if (!book) throw new Error('本が見つかりません。');
    if (!hasReadBook(member.member_id, bookId)) {
      throw new Error('読了マークが付いた人のみ読書会スレッドに投稿できます。');
    }
    const content = (contentRaw || '').trim();
    if (!content) throw new Error('投稿内容を入力してください。');

    const post = {
      post_id: Utils.uuid(),
      book_id: bookId,
      member_id: member.member_id,
      content: content,
      posted_at: Utils.now(),
    };
    SheetDB.insert('forum_posts', post);

    // 同じ本の他の読了者にDM通知
    notifyReaders(book, member);
    Badges.checkForMember(member.member_id); // 読書会常連
    return { ok: true, post_id: post.post_id };
  }

  /** 同じ本の読了者（投稿者本人を除く）にDM通知 */
  function notifyReaders(book, author) {
    const readers = {};
    SheetDB.filter('lendings', function (l) {
      return l.book_id === book.book_id && l.status === 'read';
    }).forEach(function (l) {
      if (l.borrower_id !== author.member_id) readers[l.borrower_id] = true;
    });
    Object.keys(readers).forEach(function (memberId) {
      Discord.notifyMember(memberId,
        '💬 読書会「' + book.title + '」に ' + author.discord_username + ' さんが投稿しました。\n'
        + Config.webappUrl() + '#/detail?book=' + book.book_id);
    });
  }

  return {
    hasReadBook: hasReadBook,
    listByBook: listByBook,
    post: post,
  };
})();
