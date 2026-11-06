'use strict';

/**
 * Netlify Scheduled Function: zalo-daily
 * Lịch chạy: "0 1,2,3 * * *" (01:00, 02:00, 03:00 UTC = 08:00, 09:00, 10:00 sáng giờ Việt Nam Asia/Ho_Chi_Minh).
 * Chạy nhiều lần mỗi ngày để xử lý hết tin còn dư do trần 40 tin/lần chạy (MAX_MESSAGES_PER_RUN = 40);
 * chống trùng trong transaction của NhatKy_Zalo bảo đảm không gửi lặp.
 * Không sử dụng onSnapshot.
 * Hỗ trợ ?dry=1 để chỉ ghi trạng thái DryRun vào NhatKy_Zalo mà không gọi Apps Script.
 */

const { runDailyZaloScan } = require('./_zalo-daily-core');

exports.config = {
  schedule: '0 1,2,3 * * *'
};

exports.handler = async function (event) {
  let isForceDryNoAppsScript = false;
  if (event?.queryStringParameters?.dry === '1') {
    isForceDryNoAppsScript = true;
  } else if (typeof event?.rawUrl === 'string') {
    try {
      const parsedUrl = new URL(event.rawUrl);
      if (parsedUrl.searchParams.get('dry') === '1') {
        isForceDryNoAppsScript = true;
      }
    } catch (_e) {
      // Bỏ qua lỗi parse URL
    }
  }

  try {
    const summary = await runDailyZaloScan(
      isForceDryNoAppsScript
        ? { dryRun: true, skipAppsScriptOnDryRun: true }
        : {}
    );

    console.log('[zalo-daily] Tóm tắt kết quả chạy:', JSON.stringify(summary));

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify({
        ok: true,
        summary
      })
    };
  } catch (err) {
    console.error('[zalo-daily] Lỗi khi chạy cron gửi Zalo:', err);
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify({
        ok: false,
        message: err.message || 'Lỗi khi chạy zalo-daily'
      })
    };
  }
};
