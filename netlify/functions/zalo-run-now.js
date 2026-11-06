'use strict';

/**
 * Netlify Function: zalo-run-now
 * Cho phép kích hoạt quét nhắc lịch khai giảng ngay từ giao diện ("Quét ngay (dry-run)").
 * Ép cố định dryRun = true và previewOnly = true (bỏ qua giá trị từ body), KHÔNG ghi vào NhatKy_Zalo.
 */

const { runDailyZaloScan } = require('./_zalo-daily-core');

function buildCorsHeaders(requestOrigin) {
  const configuredSiteUrl = (process.env.SITE_URL || '').trim().replace(/\/+$/, '');
  let allowOrigin = configuredSiteUrl || '*';

  if (configuredSiteUrl && requestOrigin) {
    const cleanOrigin = requestOrigin.trim().replace(/\/+$/, '');
    if (cleanOrigin === configuredSiteUrl) {
      allowOrigin = cleanOrigin;
    }
  }

  return {
    'Access-Control-Allow-Origin': allowOrigin,
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Vary': 'Origin',
    'Content-Type': 'application/json; charset=utf-8'
  };
}

exports.handler = async function (event) {
  const origin =
    (event.headers && (event.headers.origin || event.headers.Origin)) || '';
  const headers = buildCorsHeaders(origin);

  if (event.httpMethod === 'OPTIONS') {
    return {
      statusCode: 204,
      headers,
      body: ''
    };
  }

  if (event.httpMethod !== 'POST') {
    return {
      statusCode: 405,
      headers,
      body: JSON.stringify({
        ok: false,
        message: 'Chỉ hỗ trợ phương thức POST'
      })
    };
  }

  // Ép cố định dryRun = true và previewOnly = true (bỏ qua mọi giá trị từ body)
  const dryRun = true;
  const previewOnly = true;
  const skipAppsScriptOnDryRun = true;

  try {
    const summary = await runDailyZaloScan({
      dryRun,
      skipAppsScriptOnDryRun,
      previewOnly
    });

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        ok: true,
        summary,
        items: summary.items || [],
        byLoaiTin: summary.byLoaiTin || {}
      })
    };
  } catch (err) {
    console.error('[zalo-run-now] Lỗi khi quét thủ công:', err);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({
        ok: false,
        message: err.message || 'Lỗi khi chạy quét nhắc lịch'
      })
    };
  }
};
