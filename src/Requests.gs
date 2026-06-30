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
