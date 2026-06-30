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
