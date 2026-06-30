/**
 * Discord.gs
 * Discord Bot API 呼び出し（DM/チャンネル通知）と Slash Command の Interaction 処理。
 *
 * 注: トークン等が未設定の場合、通知は静かに no-op（ローカル検証を妨げない）。
 */

const Discord = (function () {
  const API = 'https://discord.com/api/v10';

  function botHeaders() {
    return {
      Authorization: 'Bot ' + Config.discordBotToken(),
      'Content-Type': 'application/json',
    };
  }

  /** 指定メンバーにDM送信（member_id を受け取り discord_id を解決） */
  function notifyMember(memberId, content) {
    try {
      const token = Config.discordBotToken();
      if (!token) { Logger.log('[DM skip] ' + content); return false; }
      const member = Members.byId(memberId);
      if (!member || !member.discord_id) return false;

      // DMチャンネルを開く
      const dmRes = UrlFetchApp.fetch(API + '/users/@me/channels', {
        method: 'post',
        headers: botHeaders(),
        muteHttpExceptions: true,
        payload: JSON.stringify({ recipient_id: member.discord_id }),
      });
      if (dmRes.getResponseCode() >= 300) return false;
      const channel = JSON.parse(dmRes.getContentText());
      return sendToChannel(channel.id, content);
    } catch (e) {
      Logger.log('notifyMember error: ' + e.message);
      return false;
    }
  }

  /** 部内お知らせチャンネルに送信 */
  function notifyChannel(content) {
    const channelId = Config.notifyChannelId();
    if (!channelId || !Config.discordBotToken()) { Logger.log('[CH skip] ' + content); return false; }
    return sendToChannel(channelId, content);
  }

  function sendToChannel(channelId, content) {
    try {
      const res = UrlFetchApp.fetch(API + '/channels/' + channelId + '/messages', {
        method: 'post',
        headers: botHeaders(),
        muteHttpExceptions: true,
        payload: JSON.stringify({ content: content }),
      });
      return res.getResponseCode() < 300;
    } catch (e) {
      Logger.log('sendToChannel error: ' + e.message);
      return false;
    }
  }

  // ─── Slash Command Interaction ──────────────────────────────────
  function jsonResponse(obj) {
    return ContentService.createTextOutput(JSON.stringify(obj))
      .setMimeType(ContentService.MimeType.JSON);
  }

  function ephemeral(content) {
    return jsonResponse({ type: 4, data: { content: content, flags: 64 } });
  }

  function linkButton(content, label, url) {
    return jsonResponse({
      type: 4,
      data: {
        content: content,
        flags: 64,
        components: [{
          type: 1,
          components: [{ type: 2, style: 5, label: label, url: url }],
        }],
      },
    });
  }

  /** doPost から呼ばれる。Discord Interactions Webhook を処理 */
  function handleInteraction(e) {
    if (!e || !e.postData) return jsonResponse({ type: 1 });
    const body = JSON.parse(e.postData.contents);

    // PING（type 1）には PONG
    if (body.type === 1) return jsonResponse({ type: 1 });

    // Application Command（type 2）
    if (body.type === 2) return handleCommand(body);

    return jsonResponse({ type: 1 });
  }

  function discordUserId(body) {
    return (body.member && body.member.user && body.member.user.id)
      || (body.user && body.user.id) || null;
  }

  function resolveMember(body) {
    const did = discordUserId(body);
    if (!did) return null;
    return SheetDB.find('members', function (m) { return String(m.discord_id) === String(did); });
  }

  function optValue(data, name) {
    if (!data.options) return null;
    function walk(opts) {
      for (let i = 0; i < opts.length; i++) {
        if (opts[i].name === name && opts[i].value !== undefined) return opts[i].value;
        if (opts[i].options) {
          const v = walk(opts[i].options);
          if (v !== null) return v;
        }
      }
      return null;
    }
    return walk(data.options);
  }

  function subCommand(data) {
    if (data.options && data.options[0] && data.options[0].type === 1) {
      return data.options[0].name;
    }
    return null;
  }

  function handleCommand(body) {
    const data = body.data;
    const name = data.name;
    const member = resolveMember(body);
    if (!member) {
      return ephemeral('あなたは部員リストに登録されていません。管理者に登録を依頼してください。');
    }
    const appUrl = Config.webappUrl();

    try {
      if (name === 'book') return handleBook(data, member, appUrl);
      if (name === 'lend') return handleLend(data, member, appUrl);
      if (name === 'waitlist') return handleWaitlist(data, member, appUrl);
      if (name === 'review') {
        const title = optValue(data, 'title');
        const book = findBookByTitle(title);
        if (!book) return ephemeral('「' + title + '」が見つかりません。');
        return linkButton('レビューはWeb Appから投稿できます。', 'レビューを書く',
          appUrl + '#/detail?book=' + book.book_id);
      }
      if (name === 'request') return handleRequest(data, member, appUrl);
      if (name === 'mypage') {
        const mp = Members.myPage(member);
        const lines = ['**マイページ**',
          '借り中: ' + mp.borrowing.length + '冊',
          '読了: ' + mp.readList.length + '冊',
          'バッジ: ' + mp.badges.length + '個'];
        if (mp.borrowing.length) {
          lines.push('', '__借り中の本__');
          mp.borrowing.forEach(function (b) {
            lines.push('・' + b.title + '（期限 ' + Utils.fmtDate(b.due_date) + '）' + (b.overdue ? ' ⚠️遅延' : ''));
          });
        }
        return ephemeral(lines.join('\n'));
      }
      if (name === 'baton') {
        const title = optValue(data, 'title');
        const book = findBookByTitle(title);
        if (!book) return ephemeral('「' + title + '」が見つかりません。');
        return linkButton('バトンリレーの指名はWeb Appから。', '指名する',
          appUrl + '#/detail?book=' + book.book_id);
      }
    } catch (err) {
      return ephemeral('エラー: ' + err.message);
    }
    return ephemeral('未対応のコマンドです。');
  }

  function findBookByTitle(title) {
    if (!title) return null;
    const t = String(title).toLowerCase();
    return SheetDB.find('books', function (b) {
      return b.title.toLowerCase().indexOf(t) >= 0;
    });
  }

  function handleBook(data, member, appUrl) {
    const sub = subCommand(data);
    if (sub === 'list') {
      const books = SheetDB.filter('books', function (b) { return b.status === 'available'; });
      if (!books.length) return ephemeral('現在、空き本はありません。');
      const lines = books.slice(0, 20).map(function (b) { return '・' + b.title + '（' + b.author + '）'; });
      return ephemeral('**空き本一覧**\n' + lines.join('\n'));
    }
    if (sub === 'search') {
      const kw = String(optValue(data, 'キーワード') || optValue(data, 'keyword') || '').toLowerCase();
      const hits = SheetDB.filter('books', function (b) {
        return b.title.toLowerCase().indexOf(kw) >= 0 || b.author.toLowerCase().indexOf(kw) >= 0;
      });
      if (!hits.length) return ephemeral('「' + kw + '」に一致する本はありません。');
      const lines = hits.slice(0, 20).map(function (b) {
        return '・' + b.title + '（' + b.status + '）';
      });
      return ephemeral('**検索結果**\n' + lines.join('\n'));
    }
    if (sub === 'info') {
      const title = optValue(data, 'title');
      const book = findBookByTitle(title);
      if (!book) return ephemeral('「' + title + '」が見つかりません。');
      const sum = Reviews.summary(book.book_id);
      const lines = ['**' + book.title + '**', '著者: ' + book.author,
        '状態: ' + book.status, 'レビュー: ' + sum.count + '件（★' + sum.avg + '）'];
      return linkButton(lines.join('\n'), '詳細を見る', appUrl + '#/detail?book=' + book.book_id);
    }
    return ephemeral('使い方: /book list | search | info');
  }

  function handleLend(data, member, appUrl) {
    const sub = subCommand(data);
    const title = optValue(data, 'title');
    const book = findBookByTitle(title);
    if (!book) return ephemeral('「' + title + '」が見つかりません。');

    if (sub === 'request') {
      Lendings.requestLend(member, book.book_id);
      return linkButton('「' + book.title + '」の貸出申請を送りました。', 'Web Appで確認',
        appUrl + '#/detail?book=' + book.book_id);
    }
    if (sub === 'return') {
      const lending = SheetDB.find('lendings', function (l) {
        return l.book_id === book.book_id && l.borrower_id === member.member_id && !l.returned_at;
      });
      if (!lending) return ephemeral('返却対象の貸出が見つかりません。');
      Lendings.returnBook(member, lending.lending_id, '');
      return ephemeral('「' + book.title + '」の返却を報告しました。');
    }
    if (sub === 'extend') {
      const lending = SheetDB.find('lendings', function (l) {
        return l.book_id === book.book_id && l.borrower_id === member.member_id && !l.returned_at;
      });
      if (!lending) return ephemeral('延長対象の貸出が見つかりません。');
      Lendings.requestExtension(member, lending.lending_id);
      return ephemeral('「' + book.title + '」の延長申請を送りました。オーナーの承認待ちです。');
    }
    return ephemeral('使い方: /lend request | return | extend');
  }

  function handleWaitlist(data, member, appUrl) {
    const sub = subCommand(data);
    const title = optValue(data, 'title');
    const book = findBookByTitle(title);
    if (!book) return ephemeral('「' + title + '」が見つかりません。');
    if (sub === 'join') {
      Lendings.joinWaitlist(member, book.book_id);
      return ephemeral('「' + book.title + '」の待ちリストに登録しました。');
    }
    return ephemeral('使い方: /waitlist join');
  }

  function handleRequest(data, member, appUrl) {
    const sub = subCommand(data);
    if (sub === 'list') {
      const reqs = Requests.list().filter(function (r) { return r.status === 'open'; });
      if (!reqs.length) return ephemeral('オープンな購入リクエストはありません。');
      const lines = reqs.slice(0, 20).map(function (r) {
        return '・' + r.title + '（' + r.vote_count + '票）';
      });
      return ephemeral('**購入リクエスト**\n' + lines.join('\n'));
    }
    if (sub === 'add') {
      const title = optValue(data, 'title');
      Requests.add(member, { title: title, reason: optValue(data, 'reason') || '（理由未記入）' });
      return ephemeral('購入リクエスト「' + title + '」を投稿しました。');
    }
    if (sub === 'vote') {
      const title = optValue(data, 'title');
      const req = SheetDB.find('requests', function (r) {
        return r.title.toLowerCase().indexOf(String(title).toLowerCase()) >= 0 && r.status === 'open';
      });
      if (!req) return ephemeral('「' + title + '」のリクエストが見つかりません。');
      const r = Requests.vote(member, req.request_id);
      return ephemeral('「' + req.title + '」に投票しました（現在 ' + r.vote_count + '票）。');
    }
    return ephemeral('使い方: /request add | list | vote');
  }

  return {
    notifyMember: notifyMember,
    notifyChannel: notifyChannel,
    sendToChannel: sendToChannel,
    handleInteraction: handleInteraction,
  };
})();
