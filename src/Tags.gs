/**
 * Tags.gs
 * タグCRUD（全部員が自由に作成、管理者が統廃合・削除）。
 */

const Tags = (function () {

  function list() {
    // 各タグの利用本数も付与
    const counts = {};
    SheetDB.read('book_tags').forEach(function (bt) {
      counts[bt.tag_id] = (counts[bt.tag_id] || 0) + 1;
    });
    return SheetDB.read('tags').map(function (t) {
      return {
        tag_id: t.tag_id,
        name: t.name,
        created_by: t.created_by,
        book_count: counts[t.tag_id] || 0,
      };
    }).sort(function (a, b) { return b.book_count - a.book_count; });
  }

  function create(member, nameRaw) {
    const name = (nameRaw || '').trim();
    if (!name) throw new Error('タグ名を入力してください。');
    const existing = SheetDB.find('tags', function (t) {
      return t.name.toLowerCase() === name.toLowerCase();
    });
    if (existing) return { ok: true, tag_id: existing.tag_id, existed: true };

    const tag = {
      tag_id: Utils.uuid(),
      name: name,
      created_by: member.member_id,
      created_at: Utils.now(),
    };
    SheetDB.insert('tags', tag);
    Badges.checkForMember(member.member_id); // タグ職人
    return { ok: true, tag_id: tag.tag_id };
  }

  /** 本のタグを丸ごと差し替え */
  function setBookTags(member, bookId, tagIds) {
    SheetDB.remove('book_tags', function (bt) { return bt.book_id === bookId; });
    (tagIds || []).forEach(function (tagId) {
      SheetDB.insert('book_tags', { book_id: bookId, tag_id: tagId });
    });
    return { ok: true };
  }

  /** fromTag を intoTag に統合（管理者） */
  function merge(fromTagId, intoTagId) {
    if (fromTagId === intoTagId) return { ok: true };
    const seen = {};
    // intoTag が既に付いている本を記録
    SheetDB.filter('book_tags', function (bt) { return bt.tag_id === intoTagId; })
      .forEach(function (bt) { seen[bt.book_id] = true; });
    // fromTag の紐付けを intoTag に張り替え（重複は除く）
    SheetDB.filter('book_tags', function (bt) { return bt.tag_id === fromTagId; })
      .forEach(function (bt) {
        if (!seen[bt.book_id]) {
          SheetDB.insert('book_tags', { book_id: bt.book_id, tag_id: intoTagId });
          seen[bt.book_id] = true;
        }
      });
    SheetDB.remove('book_tags', function (bt) { return bt.tag_id === fromTagId; });
    SheetDB.remove('tags', function (t) { return t.tag_id === fromTagId; });
    return { ok: true };
  }

  function remove(tagId) {
    SheetDB.remove('book_tags', function (bt) { return bt.tag_id === tagId; });
    SheetDB.remove('tags', function (t) { return t.tag_id === tagId; });
    return { ok: true };
  }

  return {
    list: list,
    create: create,
    setBookTags: setBookTags,
    merge: merge,
    remove: remove,
  };
})();
