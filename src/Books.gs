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
  /** NDL → Google Books の順で書誌を取得。両方ダメなら null */
  function lookupIsbn(isbnRaw) {
    const isbn = Utils.isbnNormalize(isbnRaw);
    if (!isbn) return null;
    return fetchFromNdl(isbn) || fetchFromGoogleBooks(isbn) || null;
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
        cover_url: 'https://ndlsearch.ndl.go.jp/thumbnail/' + isbn + '.jpg',
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

  return {
    raw: raw,
    toCard: toCard,
    list: list,
    detail: detail,
    lendDays: lendDays,
    lookupIsbn: lookupIsbn,
    fetchFromNdl: fetchFromNdl,
    fetchFromGoogleBooks: fetchFromGoogleBooks,
    register: register,
    updateBook: updateBook,
    deleteBook: deleteBook,
    setStatus: setStatus,
  };
})();
