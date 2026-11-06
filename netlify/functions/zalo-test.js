'use strict';

/**
 * Netlify Function: zalo-test
 * Gửi thử tin ZNS tới số điện thoại chỉ định.
 * Nhận templateId theo loaiTin từ CauHinh/zalo (templateXepLop / templateNhacT3 / templateNhacT1),
 * URL ưu tiên CauHinh/zalo.webhookUrl (fallback process.env.APPS_SCRIPT_URL),
 * secret chỉ lấy từ process.env.ZALO_SHARED_SECRET.
 */

const {
  ALLOWED_LOAI_TIN,
  getDb,
  normalizePhone,
  isValidPhone84,
  buildTemplateData,
  resolveWebhookUrl,
  resolveSharedSecret,
  resolveTemplateId,
  postToAppsScriptWithRetry
} = require('./_zalo-lib');

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
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

  if (event.httpMethod !== 'POST') {
    return {
      statusCode: 405,
      headers: CORS_HEADERS,
      body: JSON.stringify({
        ok: false,
        message: 'Chỉ hỗ trợ phương thức POST'
      })
    };
  }

  let body = {};
  try {
    body = event.body ? JSON.parse(event.body) : {};
  } catch (err) {
    return {
      statusCode: 400,
      headers: CORS_HEADERS,
      body: JSON.stringify({
        ok: false,
        message: 'Body JSON không hợp lệ: ' + err.message
      })
    };
  }

  const loaiTin = body.loaiTin && ALLOWED_LOAI_TIN.includes(body.loaiTin) ? body.loaiTin : 'XepLop';
  const rawPhone = body.phone || body.soDienThoai || '';
  const normalizedPhone = normalizePhone(rawPhone);
  const dryRun = typeof body.dryRun === 'boolean' ? body.dryRun : true;

  if (!isValidPhone84(normalizedPhone)) {
    return {
      statusCode: 400,
      headers: CORS_HEADERS,
      body: JSON.stringify({
        ok: false,
        maLoi: 'INVALID_PHONE',
        message: `Số điện thoại nhận thử không hợp lệ (${rawPhone || 'trống'})`
      })
    };
  }

  try {
    const db = getDb();
    const zaloSnap = await db.collection('CauHinh').doc('zalo').get();
    const zaloConfig = zaloSnap.exists ? zaloSnap.data() || {} : {};

    const templateId = resolveTemplateId(loaiTin, zaloConfig);
    if (!templateId) {
      return {
        statusCode: 400,
        headers: CORS_HEADERS,
        body: JSON.stringify({
          ok: false,
          maLoi: 'MISSING_TEMPLATE_ID',
          message: `Thiếu mã template ZNS cho loại tin ${loaiTin} trong CauHinh/zalo`
        })
      };
    }

    const appsScriptUrl = resolveWebhookUrl(zaloConfig);
    if (!appsScriptUrl) {
      return {
        statusCode: 400,
        headers: CORS_HEADERS,
        body: JSON.stringify({
          ok: false,
          maLoi: 'MISSING_APPS_SCRIPT_URL',
          message: 'Chưa cấu hình URL Web App Apps Script trong CauHinh/zalo.webhookUrl hoặc APPS_SCRIPT_URL'
        })
      };
    }

    const sharedSecret = resolveSharedSecret();

    const defaultTemplateData = buildTemplateData(
      {
        id: 'HV_TEST_001',
        HoTen: 'Nguyễn Văn Học Viên (Thử nghiệm)',
        MaThamChieu: 'DK-TEST01'
      },
      {
        id: 'LOP_TEST_001',
        MaLop: 'BL-DIENCN-TEST',
        TenLop: 'Điện công nghiệp K26 (Thử nghiệm)',
        TenNghe: 'Điện công nghiệp',
        NgayKhaiGiangDuKien: new Date(Date.now() + 3 * 86400000),
        LichHocCoDinh: 'Thứ 2 - Thứ 4 - Thứ 6 (18:00 - 21:00)'
      },
      {
        TenCoSo: 'Cơ sở Bến Lức',
        DiaChi: 'Số 128 Quốc lộ 1A, TT. Bến Lức, Long An',
        SoDienThoai: '02723871234'
      },
      {
        HoTen: 'Cán bộ Tư vấn Tuyển sinh',
        SoDienThoai: '0909123456'
      }
    );

    const templateData =
      body.templateData && typeof body.templateData === 'object'
        ? { ...defaultTemplateData, ...body.templateData }
        : defaultTemplateData;

    const trackingId = `TEST_${loaiTin}_${Date.now()}`;
    const payload = {
      action: 'SEND_ZNS',
      secret: sharedSecret,
      loaiTin,
      templateId,
      trackingId,
      dryRun,
      phone: normalizedPhone,
      templateData
    };

    const resp = await postToAppsScriptWithRetry(appsScriptUrl, payload, 20000);

    return {
      statusCode: 200,
      headers: CORS_HEADERS,
      body: JSON.stringify({
        ok: true,
        loaiTin,
        templateId,
        phone: normalizedPhone,
        dryRun,
        trackingId,
        appsScriptResponse: resp
      })
    };
  } catch (err) {
    console.error('[zalo-test] Lỗi gửi thử ZNS:', err);
    return {
      statusCode: 500,
      headers: CORS_HEADERS,
      body: JSON.stringify({
        ok: false,
        maLoi: err.code || 'TEST_SEND_ERROR',
        message: err.message || 'Lỗi khi gửi thử ZNS'
      })
    };
  }
};
