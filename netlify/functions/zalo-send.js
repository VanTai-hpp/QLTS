'use strict';

/**
 * GHI CHÚ BẢO MẬT (SECURITY TODO - GIAI ĐOẠN SAU):
 * Endpoint `zalo-send` hiện được gọi trực tiếp từ trình duyệt của cán bộ tuyển sinh
 * sau khi xếp lớp hoặc bấm "Gửi lại" trong Tab 2 / Modal chi tiết học viên.
 * Ở giai đoạn bảo mật tiếp theo, cần bổ sung xác thực Firebase Auth ID Token
 * (kiểm tra header Authorization: Bearer <idToken> qua admin.auth().verifyIdToken)
 * hoặc chữ ký nội bộ / Rate Limiting theo IP để chặn gọi trái phép từ bên ngoài.
 */

const { ALLOWED_LOAI_TIN, getDb, guiTin } = require('./_zalo-lib');

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
  const origin = event.headers?.origin || event.headers?.Origin || '';
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
        trangThai: 'Loi',
        message: 'Chỉ hỗ trợ phương thức POST'
      })
    };
  }

  try {
    const body = event.body ? JSON.parse(event.body) : {};
    let { idHocVien, idLop, loaiTin, docId, dryRun } = body;

    // Hỗ trợ trường hợp truyền docId khi bấm "Gửi lại" mà chưa tách sẵn tham số
    if ((!idHocVien || !idLop || !loaiTin) && docId) {
      const db = getDb();
      const logSnap = await db.collection('NhatKy_Zalo').doc(String(docId)).get();
      if (logSnap.exists) {
        const logData = logSnap.data() || {};
        idHocVien = idHocVien || logData.ID_HocVien;
        idLop = idLop || logData.ID_Lop;
        loaiTin = loaiTin || logData.LoaiTin;
      }
    }

    if (!loaiTin || !ALLOWED_LOAI_TIN.includes(loaiTin)) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({
          ok: false,
          trangThai: 'Loi',
          message: `loaiTin không hợp lệ. Chỉ chấp nhận: ${ALLOWED_LOAI_TIN.join(', ')}`
        })
      };
    }

    if (!idHocVien || !idLop) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({
          ok: false,
          trangThai: 'Loi',
          message: 'Thiếu idHocVien hoặc idLop'
        })
      };
    }

    const options = {};
    if (typeof dryRun === 'boolean') {
      options.dryRun = dryRun;
    }

    const result = await guiTin(loaiTin, String(idHocVien), String(idLop), options);

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        ok: Boolean(result.ok),
        trangThai: result.trangThai,
        docId: result.docId || null,
        maLoi: result.maLoi || null,
        ghiChu: result.ghiChu || ''
      })
    };
  } catch (err) {
    console.error('[zalo-send] Error:', err);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({
        ok: false,
        trangThai: 'Loi',
        message: err.message || 'Lỗi máy chủ khi gửi tin Zalo'
      })
    };
  }
};
