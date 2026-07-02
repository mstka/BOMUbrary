/**
 * Domain.gs — 業務ロジック
 *  統合元: Members / Books / Tags / Lendings / Penalty / Reviews /
 *          Requests / Forum / Baton / Badges / Admin
 */

/* ======================================================================
 *  Members
 * ==================================================================== */

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

/* ======================================================================
 *  Books
 * ==================================================================== */

/**
 * Books.gs
 * 蔵書CRUD・検索・ISBN書誌取得（NDL → Google Books → 手動）。
 */

const Books = (function () {

  function raw(bookId) {
    return SheetDB.find('books', function (b) { return b.book_id === bookId; });
  }

  /** 一覧用カード（タグ・現在の借り手を付与） */
  function toCard(book) {
    return {
      book_id: book.book_id,
      title: book.title,
      author: book.author,
      publisher: book.publisher,
      isbn: book.isbn,
      cover_url: book.cover_url,
      page_count: book.page_count,
      condition: book.condition,
      status: book.status,
      owner_id: book.owner_id,
      external_link: book.external_link,
      pending_enrichment: book.pending_enrichment,
    };
  }

  /** 蔵書一覧（タグと現在の貸出情報を結合） */
  function list() {
    const books = SheetDB.read('books');
    const bookTags = SheetDB.read('book_tags');
    const tags = {};
    SheetDB.read('tags').forEach(function (t) { tags[t.tag_id] = t.name; });
    const names = Members.nameMap();

    // book_id → タグ名配列
    const tagsByBook = {};
    bookTags.forEach(function (bt) {
      if (!tagsByBook[bt.book_id]) tagsByBook[bt.book_id] = [];
      if (tags[bt.tag_id]) {
        tagsByBook[bt.book_id].push({ tag_id: bt.tag_id, name: tags[bt.tag_id] });
      }
    });

    // book_id → 現在の借り手（承認済みで未返却のもののみ）
    const activeLend = {};
    SheetDB.read('lendings').forEach(function (l) {
      if (!l.returned_at && l.status !== 'requested' && l.lent_at) activeLend[l.book_id] = l;
    });

    return books.map(function (b) {
      const card = toCard(b);
      card.tags = tagsByBook[b.book_id] || [];
      card.owner_name = names[b.owner_id] || '';
      const lend = activeLend[b.book_id];
      card.borrower_name = lend ? (names[lend.borrower_id] || '') : '';
      card.due_date = lend ? Utils.iso(Utils.parseDate(lend.due_date)) : null;
      return card;
    });
  }

  /** 本の詳細（貸出履歴・レビュー・バトン・待ちリスト・タグ込み） */
  function detail(bookId) {
    const book = raw(bookId);
    if (!book) throw new Error('本が見つかりません。');
    const names = Members.nameMap();

    const card = toCard(book);
    card.owner_name = names[book.owner_id] || '';

    // タグ
    const tagNames = {};
    SheetDB.read('tags').forEach(function (t) { tagNames[t.tag_id] = t.name; });
    card.tags = SheetDB.filter('book_tags', function (bt) { return bt.book_id === bookId; })
      .map(function (bt) { return { tag_id: bt.tag_id, name: tagNames[bt.tag_id] }; })
      .filter(function (t) { return t.name; });

    // 貸出履歴
    const lendings = SheetDB.filter('lendings', function (l) { return l.book_id === bookId; })
      .sort(function (a, b) {
        return new Date(b.lent_at).getTime() - new Date(a.lent_at).getTime();
      });
    card.history = lendings.map(function (l) {
      return {
        lending_id: l.lending_id,
        borrower_name: names[l.borrower_id] || '',
        borrower_id: l.borrower_id,
        lent_at: Utils.iso(Utils.parseDate(l.lent_at)),
        due_date: Utils.iso(Utils.parseDate(l.due_date)),
        returned_at: Utils.iso(Utils.parseDate(l.returned_at)),
        status: l.status,
        return_condition: l.return_condition,
      };
    });
    const current = lendings.filter(function (l) {
      return !l.returned_at && l.status !== 'requested' && l.lent_at;
    })[0];
    card.current_lending = current ? {
      lending_id: current.lending_id,
      borrower_id: current.borrower_id,
      borrower_name: names[current.borrower_id] || '',
      due_date: Utils.iso(Utils.parseDate(current.due_date)),
      status: current.status,
      extended: current.extended,
    } : null;

    // 待ちリスト
    card.waitlist = SheetDB.filter('waitlist', function (w) { return w.book_id === bookId; })
      .sort(function (a, b) { return new Date(a.registered_at) - new Date(b.registered_at); })
      .map(function (w) {
        return { member_id: w.member_id, member_name: names[w.member_id] || '' };
      });

    return card;
  }

  /** 標準貸与日数（300ページ以上は4週間） */
  function lendDays(book) {
    return (book.page_count >= Rules.LONG_BOOK_PAGE_THRESHOLD)
      ? Rules.LONG_BOOK_LEND_DAYS
      : Rules.DEFAULT_LEND_DAYS;
  }

  // ─── ISBN書誌取得 ───────────────────────────────────────────────
  /**
   * NDL → openBD → Google Books の順で書誌を取得。
   * 表紙は別途 resolveCover() で信頼できるソース（openBD/Google）から解決する。
   * （NDLのサムネイルURLは CloudFront でホットリンクが 403 になるため使わない）
   */
  function lookupIsbn(isbnRaw) {
    const isbn = Utils.isbnNormalize(isbnRaw);
    if (!isbn) return null;
    const meta = fetchFromNdl(isbn) || fetchFromOpenBd(isbn) || fetchFromGoogleBooks(isbn);
    if (!meta) return null;
    if (!meta.cover_url) meta.cover_url = resolveCover(isbn);
    return meta;
  }

  /** 表紙画像URLを信頼できるソースから解決（openBD → Google Books） */
  function resolveCover(isbn) {
    // 1) openBD の表紙（cover.openbd.jp・ホットリンク可）
    try {
      const res = UrlFetchApp.fetch('https://api.openbd.jp/v1/get?isbn=' + encodeURIComponent(isbn),
        { muteHttpExceptions: true });
      if (res.getResponseCode() === 200) {
        const arr = JSON.parse(res.getContentText());
        if (arr && arr[0] && arr[0].summary && arr[0].summary.cover) return arr[0].summary.cover;
      }
    } catch (e) { /* ignore */ }
    // 2) Google Books の表紙
    const g = fetchFromGoogleBooks(isbn);
    if (g && g.cover_url) return g.cover_url;
    return '';
  }

  /** openBD（日本の書誌DB）から取得。表紙も含む */
  function fetchFromOpenBd(isbn) {
    try {
      const res = UrlFetchApp.fetch('https://api.openbd.jp/v1/get?isbn=' + encodeURIComponent(isbn),
        { muteHttpExceptions: true });
      if (res.getResponseCode() !== 200) return null;
      const arr = JSON.parse(res.getContentText());
      if (!arr || !arr.length || !arr[0]) return null;
      const rec = arr[0];
      const s = rec.summary || {};
      if (!s.title) return null;
      return {
        title: s.title,
        author: s.author || '',
        publisher: s.publisher || '',
        isbn: isbn,
        page_count: openBdPages(rec),
        cover_url: s.cover || '',
        source: 'openBD',
      };
    } catch (e) {
      return null;
    }
  }

  /** openBD の ONIX からページ数を推定 */
  function openBdPages(rec) {
    try {
      const ext = rec.onix && rec.onix.DescriptiveDetail && rec.onix.DescriptiveDetail.Extent;
      if (ext && ext.length) {
        for (let i = 0; i < ext.length; i++) {
          if (ext[i].ExtentValue) return Number(ext[i].ExtentValue) || 0;
        }
      }
    } catch (e) { /* ignore */ }
    return 0;
  }

  /** 国立国会図書館サーチAPI（OpenSearch / RSS）から取得 */
  function fetchFromNdl(isbn) {
    try {
      const url = 'https://ndlsearch.ndl.go.jp/api/opensearch?isbn=' + encodeURIComponent(isbn);
      const res = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
      if (res.getResponseCode() !== 200) return null;
      const xml = res.getContentText();
      const doc = XmlService.parse(xml);
      const root = doc.getRootElement();
      const channel = root.getChild('channel');
      if (!channel) return null;
      const item = channel.getChild('item');
      if (!item) return null;

      const dc = XmlService.getNamespace('http://purl.org/dc/elements/1.1/');
      const dcndl = XmlService.getNamespace('http://ndl.go.jp/dcndl/terms/');

      function txt(parent, name, ns) {
        const el = ns ? parent.getChild(name, ns) : parent.getChild(name);
        return el ? el.getText().trim() : '';
      }

      const title = txt(item, 'title', dc) || txt(item, 'title');
      if (!title) return null;
      let pages = 0;
      const extent = txt(item, 'extent', dcndl);
      const m = extent.match(/(\d+)\s*p/);
      if (m) pages = Number(m[1]);

      return {
        title: title,
        author: txt(item, 'creator', dc) || txt(item, 'author'),
        publisher: txt(item, 'publisher', dc),
        isbn: isbn,
        page_count: pages,
        cover_url: '', // NDLサムネイルはホットリンク不可。resolveCover() で別途解決
        source: 'NDL',
      };
    } catch (e) {
      return null;
    }
  }

  /** Google Books API から取得 */
  function fetchFromGoogleBooks(isbn) {
    try {
      let url = 'https://www.googleapis.com/books/v1/volumes?q=isbn:' + encodeURIComponent(isbn);
      const key = Config.googleBooksApiKey();
      if (key) url += '&key=' + key;
      const res = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
      if (res.getResponseCode() !== 200) return null;
      const data = JSON.parse(res.getContentText());
      if (!data.items || !data.items.length) return null;
      const v = data.items[0].volumeInfo || {};
      if (!v.title) return null;
      const cover = (v.imageLinks && (v.imageLinks.thumbnail || v.imageLinks.smallThumbnail)) || '';
      return {
        title: v.title,
        author: (v.authors || []).join(', '),
        publisher: v.publisher || '',
        isbn: isbn,
        page_count: v.pageCount || 0,
        cover_url: cover.replace('http://', 'https://'),
        source: 'GoogleBooks',
      };
    } catch (e) {
      return null;
    }
  }

  // ─── CRUD ───────────────────────────────────────────────────────
  function register(member, payload) {
    const title = (payload.title || '').trim();
    if (!title) throw new Error('タイトルは必須です。');

    const book = {
      book_id: Utils.uuid(),
      title: title,
      author: (payload.author || '').trim(),
      publisher: (payload.publisher || '').trim(),
      isbn: Utils.isbnNormalize(payload.isbn),
      cover_url: (payload.cover_url || '').trim(),
      page_count: Number(payload.page_count) || 0,
      condition: payload.condition || '良好',
      status: 'available',
      owner_id: member.member_id,
      external_link: (payload.external_link || '').trim(),
      pending_enrichment: !!payload.pending_enrichment,
      registered_at: Utils.now(),
    };
    SheetDB.insert('books', book);

    // タグ付与
    if (payload.tagIds && payload.tagIds.length) {
      Tags.setBookTags(member, book.book_id, payload.tagIds);
    }

    // バッジ判定（蔵書貢献者）
    Badges.checkForMember(member.member_id);

    return { ok: true, book_id: book.book_id };
  }

  function updateBook(member, bookId, patch) {
    const book = raw(bookId);
    if (!book) throw new Error('本が見つかりません。');
    if (book.owner_id !== member.member_id && member.role !== 'admin') {
      throw new Error('この本を編集する権限がありません。');
    }
    const allowed = ['title', 'author', 'publisher', 'isbn', 'cover_url',
      'page_count', 'condition', 'external_link'];
    const clean = {};
    allowed.forEach(function (k) {
      if (patch[k] !== undefined) clean[k] = patch[k];
    });
    if (clean.isbn !== undefined) clean.isbn = Utils.isbnNormalize(clean.isbn);
    if (clean.page_count !== undefined) clean.page_count = Number(clean.page_count) || 0;
    SheetDB.update('books', 'book_id', bookId, clean);

    if (patch.tagIds) Tags.setBookTags(member, bookId, patch.tagIds);
    return { ok: true };
  }

  function deleteBook(member, bookId) {
    const book = raw(bookId);
    if (!book) throw new Error('本が見つかりません。');
    if (book.owner_id !== member.member_id && member.role !== 'admin') {
      throw new Error('この本を削除する権限がありません。');
    }
    const active = SheetDB.find('lendings', function (l) {
      return l.book_id === bookId && !l.returned_at;
    });
    if (active) throw new Error('貸出中の本は削除できません。');

    SheetDB.remove('books', function (b) { return b.book_id === bookId; });
    SheetDB.remove('book_tags', function (bt) { return bt.book_id === bookId; });
    SheetDB.remove('waitlist', function (w) { return w.book_id === bookId; });
    return { ok: true };
  }

  function setStatus(bookId, status) {
    SheetDB.update('books', 'book_id', bookId, { status: status });
  }

  // ─── 表紙画像アップロード（撮影画像を Google Drive に保存） ───────
  /** 表紙画像を保存する専用フォルダを取得（無ければ作成しIDを保存） */
  function coverFolder() {
    const props = PropertiesService.getScriptProperties();
    const fid = props.getProperty('COVER_FOLDER_ID');
    if (fid) {
      try { return DriveApp.getFolderById(fid); } catch (e) { /* 消えていたら作り直す */ }
    }
    const folder = DriveApp.createFolder('BOMUbrary Covers');
    props.setProperty('COVER_FOLDER_ID', folder.getId());
    return folder;
  }

  /**
   * base64 dataURL の画像を Drive に保存し、埋め込み可能な公開URLを返す。
   * payload: { dataUrl: 'data:image/jpeg;base64,...', filename }
   */
  function uploadCover(member, payload) {
    const dataUrl = (payload && payload.dataUrl) || '';
    const m = /^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/.exec(dataUrl);
    if (!m) throw new Error('画像データが不正です。');
    const contentType = m[1];
    const ext = (contentType.split('/')[1] || 'jpg').replace('jpeg', 'jpg');
    const bytes = Utilities.base64Decode(m[2]);
    const name = 'cover_' + member.member_id + '_' + Date.now() + '.' + ext;
    const blob = Utilities.newBlob(bytes, contentType, name);

    const file = coverFolder().createFile(blob);
    try {
      file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
    } catch (e) { /* 共有ドライブ等で失敗しても続行 */ }

    const id = file.getId();
    // 埋め込みに強い Drive サムネイルURL（公開ファイルなら <img> で表示可）
    const url = 'https://drive.google.com/thumbnail?id=' + id + '&sz=w800';
    return { ok: true, url: url, file_id: id };
  }

  return {
    raw: raw,
    toCard: toCard,
    list: list,
    detail: detail,
    lendDays: lendDays,
    lookupIsbn: lookupIsbn,
    resolveCover: resolveCover,
    fetchFromNdl: fetchFromNdl,
    fetchFromOpenBd: fetchFromOpenBd,
    fetchFromGoogleBooks: fetchFromGoogleBooks,
    register: register,
    updateBook: updateBook,
    deleteBook: deleteBook,
    setStatus: setStatus,
    uploadCover: uploadCover,
  };
})();

/* ======================================================================
 *  Tags
 * ==================================================================== */

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

/* ======================================================================
 *  Lendings
 * ==================================================================== */

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

/* ======================================================================
 *  Penalty
 * ==================================================================== */

/**
 * Penalty.gs
 * 返却遅延ペナルティの計算・執行・リセット。
 *
 * 計算式（仕様書）:
 *   直近3ヶ月以内のペナルティ回数 n に対し、停止日数 = 3 + 2 * n
 *   最後のペナルティから3ヶ月以上空いていれば penalty_count を 0 にリセットしてから計算。
 */

const Penalty = (function () {

  /** 遅延に対しペナルティを課す */
  function apply(memberId, lendingId) {
    const member = Members.byId(memberId);
    if (!member) return null;

    const now = Utils.now();
    const lastPenalty = Utils.parseDate(member.last_penalty_at);

    // 3ヶ月リセット判定
    let count = member.penalty_count || 0;
    if (lastPenalty) {
      const resetThreshold = Utils.addMonths(lastPenalty, Rules.PENALTY_RESET_MONTHS);
      if (now.getTime() >= resetThreshold.getTime()) count = 0;
    } else {
      count = 0;
    }

    const stopDays = Rules.PENALTY_BASE_DAYS + Rules.PENALTY_STEP_DAYS * count;
    const expires = Utils.addDays(now, stopDays);

    // members 更新
    SheetDB.update('members', 'member_id', memberId, {
      penalty_until: expires,
      penalty_count: count + 1,
      last_penalty_at: now,
    });

    // ログ記録
    SheetDB.insert('penalty_log', {
      penalty_id: Utils.uuid(),
      member_id: memberId,
      lending_id: lendingId || '',
      stop_days: stopDays,
      penalty_at: now,
      expires_at: expires,
    });

    // 本人DM + 部内チャンネルで全員可視化
    const book = (function () {
      const l = Lendings.byId(lendingId);
      return l ? Books.raw(l.book_id) : null;
    })();
    const bookTitle = book ? book.title : '';
    Discord.notifyMember(memberId,
      '⚠️ **返却遅延ペナルティ**\n' + (bookTitle ? '「' + bookTitle + '」の返却が遅れました。\n' : '')
      + stopDays + '日間の借出停止（' + Utils.fmtDate(expires) + ' まで）が課されました。');
    Discord.notifyChannel(
      '🚨 返却遅延: ' + member.discord_username + ' さん'
      + (bookTitle ? '（「' + bookTitle + '」）' : '')
      + ' に ' + stopDays + '日間の借出停止が課されました。');

    return { stop_days: stopDays, expires_at: Utils.iso(expires) };
  }

  /** 管理者による手動ペナルティ解除 */
  function clear(memberId) {
    const member = Members.byId(memberId);
    if (!member) throw new Error('メンバーが見つかりません。');
    SheetDB.update('members', 'member_id', memberId, { penalty_until: '' });
    Discord.notifyMember(memberId, '✅ 借出停止が解除されました。');
    return { ok: true };
  }

  /**
   * 3ヶ月経過分の penalty_count リセット（cronから毎日呼ぶ）。
   * 最後のペナルティから3ヶ月以上経過していれば penalty_count を 0 に戻す。
   */
  function resetExpiredCounts() {
    const now = Utils.now();
    let reset = 0;
    SheetDB.read('members').forEach(function (m) {
      if (!m.penalty_count) return;
      const last = Utils.parseDate(m.last_penalty_at);
      if (!last) return;
      if (now.getTime() >= Utils.addMonths(last, Rules.PENALTY_RESET_MONTHS).getTime()) {
        SheetDB.update('members', 'member_id', m.member_id, { penalty_count: 0 });
        reset++;
      }
    });
    return reset;
  }

  return {
    apply: apply,
    clear: clear,
    resetExpiredCounts: resetExpiredCounts,
  };
})();

/* ======================================================================
 *  Reviews
 * ==================================================================== */

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

/* ======================================================================
 *  Requests
 * ==================================================================== */

/**
 * Requests.gs
 * 購入リクエスト・投票（閾値なし。可視化のみ。購入判断は管理者）。
 */

const Requests = (function () {

  function list() {
    const names = Members.nameMap();
    return SheetDB.read('requests').map(function (r) {
      return {
        request_id: r.request_id,
        title: r.title,
        author: r.author,
        isbn: r.isbn,
        reason: r.reason,
        requested_by: r.requested_by,
        requester_name: names[r.requested_by] || '',
        status: r.status,
        vote_count: r.vote_count || 0,
        requested_at: Utils.iso(Utils.parseDate(r.requested_at)),
      };
    }).sort(function (a, b) {
      // open を上に、票数の多い順
      if ((a.status === 'open') !== (b.status === 'open')) return a.status === 'open' ? -1 : 1;
      return b.vote_count - a.vote_count;
    });
  }

  function add(member, payload) {
    const title = (payload.title || '').trim();
    if (!title) throw new Error('タイトルは必須です。');
    const reason = (payload.reason || '').trim();
    if (!reason) throw new Error('読みたい理由は必須です。');

    const req = {
      request_id: Utils.uuid(),
      title: title,
      author: (payload.author || '').trim(),
      isbn: Utils.isbnNormalize(payload.isbn),
      reason: reason,
      requested_by: member.member_id,
      status: 'open',
      vote_count: 1, // 起案者の1票
      requested_at: Utils.now(),
    };
    SheetDB.insert('requests', req);
    SheetDB.insert('request_votes', {
      request_id: req.request_id,
      member_id: member.member_id,
      voted_at: Utils.now(),
    });
    Discord.notifyChannel('🆕 購入リクエスト: 「' + title + '」が ' + member.discord_username + ' さんから投稿されました。');
    return { ok: true, request_id: req.request_id };
  }

  function vote(member, requestId) {
    const req = SheetDB.find('requests', function (r) { return r.request_id === requestId; });
    if (!req) throw new Error('リクエストが見つかりません。');
    if (req.status !== 'open') throw new Error('このリクエストはすでに処理済みです。');

    const dup = SheetDB.find('request_votes', function (v) {
      return v.request_id === requestId && v.member_id === member.member_id;
    });
    if (dup) throw new Error('すでに投票済みです。');

    SheetDB.insert('request_votes', {
      request_id: requestId,
      member_id: member.member_id,
      voted_at: Utils.now(),
    });
    const newCount = (req.vote_count || 0) + 1;
    SheetDB.update('requests', 'request_id', requestId, { vote_count: newCount });
    Discord.notifyChannel('👍 「' + req.title + '」に投票がありました（現在 ' + newCount + '票）。');
    return { ok: true, vote_count: newCount };
  }

  /** 管理者: 購入済み or 却下 */
  function decide(admin, requestId, action) {
    const req = SheetDB.find('requests', function (r) { return r.request_id === requestId; });
    if (!req) throw new Error('リクエストが見つかりません。');

    if (action === 'purchased') {
      SheetDB.update('requests', 'request_id', requestId, { status: 'purchased' });
      // 蔵書に自動登録（書誌が取れれば補完）
      let meta = null;
      if (req.isbn) meta = Books.lookupIsbn(req.isbn);
      Books.register(admin, {
        title: (meta && meta.title) || req.title,
        author: (meta && meta.author) || req.author,
        publisher: (meta && meta.publisher) || '',
        isbn: req.isbn,
        cover_url: (meta && meta.cover_url) || '',
        page_count: (meta && meta.page_count) || 0,
        condition: '新品',
        pending_enrichment: req.isbn && !meta,
      });
      Discord.notifyMember(req.requested_by,
        '🎉 あなたの購入リクエスト「' + req.title + '」が購入され、蔵書に追加されました！');
      Badges.checkForMember(req.requested_by); // リクエスター
      return { ok: true, status: 'purchased' };
    }

    if (action === 'rejected') {
      SheetDB.update('requests', 'request_id', requestId, { status: 'rejected' });
      Discord.notifyMember(req.requested_by,
        'ℹ️ 購入リクエスト「' + req.title + '」は今回は見送りとなりました。');
      return { ok: true, status: 'rejected' };
    }

    throw new Error('不正な操作です。');
  }

  return {
    list: list,
    add: add,
    vote: vote,
    decide: decide,
  };
})();

/* ======================================================================
 *  Forum
 * ==================================================================== */

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

/* ======================================================================
 *  Baton
 * ==================================================================== */

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

/* ======================================================================
 *  Badges
 * ==================================================================== */

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

/* ======================================================================
 *  Admin
 * ==================================================================== */

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
