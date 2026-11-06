'use strict';

/**
 * Netlify Function: zalo-status
 * Kiểm tra trạng thái cấu hình kết nối Firebase, Apps Script URL, Secret, Site URL và 3 mã Template.
 * Chỉ trả về các giá trị boolean:
 * {firebaseOk, webhookUrlSet, secretSet, siteUrlSet, templateXepLopSet, templateNhacT3Set, templateNhacT1Set}
 */

const { getDb, resolveWebhookUrl, resolveSharedSecret, resolveTemplateId } = require('./_zalo-lib');

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Content-Type': 'application/json; charset=utf-8'
};

exports.handler = async function (event) {
  if (event.httpMethod === 'OPTIONS') {
    return {
      statusCode: 204,
      headers: CORS_HEADERS,
      body: ''
    };
  }

  let firebaseOk = false;
  let zaloConfig = {};

  try {
    const db = getDb();
    const snap = await db.collection('CauHinh').doc('zalo').get();
    firebaseOk = true;
    if (snap.exists) {
      zaloConfig = snap.data() || {};
    }
  } catch (_err) {
    firebaseOk = false;
  }

  const webhookUrl = resolveWebhookUrl(zaloConfig);
  const secret = resolveSharedSecret();
  const siteUrl = String(process.env.SITE_URL || '').trim();

  const statusPayload = {
    firebaseOk: Boolean(firebaseOk),
    webhookUrlSet: Boolean(webhookUrl.length > 0),
    secretSet: Boolean(secret.length > 0),
    siteUrlSet: Boolean(siteUrl.length > 0),
    templateXepLopSet: Boolean(resolveTemplateId('XepLop', zaloConfig).length > 0),
    templateNhacT3Set: Boolean(resolveTemplateId('NhacT3', zaloConfig).length > 0),
    templateNhacT1Set: Boolean(resolveTemplateId('NhacT1', zaloConfig).length > 0)
  };

  return {
    statusCode: 200,
    headers: CORS_HEADERS,
    body: JSON.stringify(statusPayload)
  };
};
