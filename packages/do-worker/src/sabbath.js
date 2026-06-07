/**
 * 柏林 SDA 安息日判断
 *
 * SDA 教义：第七日（Saturday）是安息日，从周五日落开始到周六日落结束
 * 柏林（Berlin）2026 年大概：周五 ~17:00 UTC（夏季） / 16:00 UTC（冬季）
 * 简化版本：用周五 17:00 UTC ~ 周六 17:00 UTC 作为保守窗口
 *
 * 任何 DCA 决策在安息日内强制 hold
 */

/**
 * @returns {boolean} 当前是否在安息日内
 */
export function isSabbath() {
	const now = new Date();
	const utcDay = now.getUTCDay(); // 0=Sun, 5=Fri, 6=Sat
	const utcHour = now.getUTCHours();

	// 周五 17:00 UTC 起
	if (utcDay === 5 && utcHour >= 17) return true;
	// 周六 17:00 UTC 止
	if (utcDay === 6 && utcHour < 17) return true;
	return false;
}

/**
 * 距离安息日结束还有多少秒（用于 UI 显示倒计时）
 * @returns {number} 秒数（0 表示不在安息日）
 */
export function secondsToSabbathEnd() {
	if (!isSabbath()) return 0;
	const now = new Date();
	const next = new Date(now);
	const utcDay = now.getUTCDay();

	if (utcDay === 5) {
		// 周五 → 周六 17:00 UTC
		next.setUTCDate(next.getUTCDate() + 1);
		next.setUTCHours(17, 0, 0, 0);
	} else {
		// 周六 → 17:00 UTC 当日
		next.setUTCHours(17, 0, 0, 0);
	}
	return Math.max(0, Math.floor((next.getTime() - now.getTime()) / 1000));
}
