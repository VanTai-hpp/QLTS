'use strict';

/**
 * Netlify Function: nguoidung-admin
 * Quản trị tài khoản người dùng nội bộ (Firebase Auth + CanBo_TuyenSinh + NhatKyQuanTri)
 * - Yêu cầu POST JSON kèm header Authorization: Bearer <ID token>
 * - Xác thực token qua admin.auth().verifyIdToken
 * - Chỉ cho phép người gọi có CanBo_TuyenSinh (TrangThai == 'HoatDong' && VaiTro == 'Admin')
 *   hoặc email trùng process.env.BOOTSTRAP_ADMIN_EMAIL khi chưa có Admin nào hoạt động trong CanBo_TuyenSinh.
 * - Tuyệt đối không ghi mật khẩu vào Firestore hay log.
 */

const { admin, getDb, getAuth, normalizePhone } = require('./_zalo-lib');

const ALLOWED_VAI_TRO = ['Admin', 'QuanLyCoSo', 'TuVanVien', 'DaoTao'];
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function buildCorsHeaders(requestOrigin) {
  const configuredSiteUrl = String(process.env.SITE_URL || '').trim().replace(/\/+$/, '');
  let allowOrigin = configuredSiteUrl || '*';

  if (configuredSiteUrl && requestOrigin) {
    const cleanOrigin = String(requestOrigin).trim().replace(/\/+$/, '');
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

function jsonResponse(statusCode, headers, payload) {
  return {
    statusCode,
    headers,
    body: JSON.stringify(payload)
  };
}

function normalizeEmailLower(rawEmail) {
  return String(rawEmail || '').trim().toLowerCase();
}

function normalizePhone10(rawPhone) {
  const p = String(rawPhone || '').replace(/\D+/g, '');
  if (p.startsWith('84') && p.length === 11) {
    return '0' + p.slice(2);
  }
  return p;
}

/**
 * Tra cứu cán bộ trong CanBo_TuyenSinh theo EmailLower (hoặc fallback Email không phân biệt hoa thường cho dữ liệu cũ)
 */
async function findCanBoByEmail(db, emailLower) {
  if (!emailLower) return null;

  const snapLower = await db
    .collection('CanBo_TuyenSinh')
    .where('EmailLower', '==', emailLower)
    .limit(5)
    .get();

  if (!snapLower.empty) {
    const doc = snapLower.docs[0];
    return { id: doc.id, ...doc.data() };
  }

  // Fallback quét bảng CanBo_TuyenSinh cho các bản ghi cũ chưa có trường EmailLower
  const allSnap = await db.collection('CanBo_TuyenSinh').limit(300).get();
  for (const doc of allSnap.docs) {
    const d = doc.data() || {};
    const docEmail = normalizeEmailLower(d.EmailLower || d.Email);
    if (docEmail && docEmail === emailLower) {
      return { id: doc.id, ...d };
    }
  }

  return null;
}

/**
 * Đếm số lượng Admin đang hoạt động (TrangThai == 'HoatDong' && VaiTro == 'Admin')
 * Nếu excludeCanBoId được truyền vào thì trừ cán bộ đó ra (dùng để kiểm tra còn ít nhất 1 Admin).
 */
async function countActiveAdmins(db, excludeCanBoId = null) {
  const snap = await db.collection('CanBo_TuyenSinh').limit(300).get();
  let count = 0;
  for (const doc of snap.docs) {
    if (excludeCanBoId && doc.id === excludeCanBoId) continue;
    const d = doc.data() || {};
    const trangThai = d.TrangThai || 'HoatDong';
    const vaiTro = d.VaiTro || 'TuVanVien';
    if (trangThai === 'HoatDong' && vaiTro === 'Admin') {
      count++;
    }
  }
  return count;
}

/**
 * Ghi nhật ký quản trị vào collection NhatKyQuanTri (tuyệt đối không chứa mật khẩu)
 */
async function writeAdminAuditLog(db, callerInfo, hanhDong, doiTuongId, ghiChu) {
  try {
    await db.collection('NhatKyQuanTri').add({
      ID_NguoiThucHien: callerInfo.canBoId || callerInfo.uid || 'bootstrap_admin',
      Email: callerInfo.emailLower || '',
      HanhDong: String(hanhDong || ''),
      DoiTuong: String(doiTuongId || ''),
      ThoiGian: admin.firestore.FieldValue.serverTimestamp(),
      GhiChu: String(ghiChu || '')
    });
  } catch (_err) {
    // Không làm gián đoạn luồng chính nếu lỗi ghi log phụ
  }
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
    return jsonResponse(405, headers, {
      ok: false,
      message: 'Chỉ hỗ trợ phương thức POST'
    });
  }

  // 1. Lấy Bearer token từ header Authorization
  const authHeader = event.headers?.authorization || event.headers?.Authorization || '';
  const match = String(authHeader).match(/^Bearer\s+(.+)$/i);
  if (!match || !match[1]) {
    return jsonResponse(401, headers, {
      ok: false,
      message: 'Thiếu token xác thực (Authorization: Bearer)'
    });
  }
  const idToken = match[1].trim();

  let db;
  let auth;
  try {
    db = getDb();
    auth = getAuth();
  } catch (initErr) {
    return jsonResponse(500, headers, {
      ok: false,
      message: 'Chưa cấu hình kết nối Firebase Admin trên máy chủ'
    });
  }

  // 2. Xác thực ID Token bằng admin.auth().verifyIdToken
  let decodedToken;
  try {
    decodedToken = await auth.verifyIdToken(idToken, true);
  } catch (verifyErr) {
    const code = verifyErr?.code || '';
    if (code === 'auth/user-disabled') {
      return jsonResponse(403, headers, {
        ok: false,
        message: 'Tài khoản đã bị khóa'
      });
    }
    return jsonResponse(401, headers, {
      ok: false,
      message: 'Phiên đăng nhập không hợp lệ hoặc đã hết hạn'
    });
  }

  const callerEmailLower = normalizeEmailLower(decodedToken.email);
  const callerUid = decodedToken.uid || '';
  if (!callerEmailLower) {
    return jsonResponse(403, headers, {
      ok: false,
      message: 'Tài khoản không có email hợp lệ'
    });
  }

  let body = {};
  try {
    body = event.body ? JSON.parse(event.body) : {};
  } catch (_e) {
    return jsonResponse(400, headers, {
      ok: false,
      message: 'Dữ liệu JSON gửi lên không hợp lệ'
    });
  }

  const action = String(body.action || '').trim();
  const bootstrapEnvEmail = normalizeEmailLower(process.env.BOOTSTRAP_ADMIN_EMAIL);

  try {
    const callerCanBo = await findCanBoByEmail(db, callerEmailLower);
    const activeAdminCount = await countActiveAdmins(db, null);

    const isCallerActiveCanBo = Boolean(
      callerCanBo && (callerCanBo.TrangThai || 'HoatDong') === 'HoatDong'
    );
    const callerRoleInDb = callerCanBo ? (callerCanBo.VaiTro || 'TuVanVien') : null;

    // Ngoại lệ Bootstrap: email trùng BOOTSTRAP_ADMIN_EMAIL được coi là Admin khi chưa có Admin nào hoạt động trong CanBo_TuyenSinh
    const isBootstrapAdmin = Boolean(
      bootstrapEnvEmail &&
        callerEmailLower === bootstrapEnvEmail &&
        activeAdminCount === 0
    );

    const effectiveVaiTro = isBootstrapAdmin
      ? 'Admin'
      : isCallerActiveCanBo
      ? callerRoleInDb
      : null;

    // Action 'whoami': hỗ trợ kiểm tra quyền và bootstrap khi vừa đăng nhập
    if (action === 'whoami') {
      if (!isBootstrapAdmin && !isCallerActiveCanBo) {
        return jsonResponse(403, headers, {
          ok: false,
          laBootstrap: false,
          vaiTro: null,
          canBo: null,
          message: 'Tài khoản chưa được cấp quyền, hãy liên hệ quản trị'
        });
      }

      // Nếu là cán bộ hợp lệ, đồng bộ AuthUid và EmailLower nếu còn trống
      let syncedCanBo = callerCanBo;
      if (callerCanBo) {
        const updates = {
          LanDangNhapCuoi: admin.firestore.FieldValue.serverTimestamp()
        };
        if (!callerCanBo.AuthUid && callerUid) {
          updates.AuthUid = callerUid;
        }
        if (!callerCanBo.EmailLower) {
          updates.EmailLower = callerEmailLower;
          updates.TaiKhoan = callerEmailLower;
        }
        if (isBootstrapAdmin && callerCanBo.VaiTro !== 'Admin') {
          updates.VaiTro = 'Admin';
        }
        await db.collection('CanBo_TuyenSinh').doc(callerCanBo.id).set(updates, { merge: true });
        syncedCanBo = {
          ...callerCanBo,
          AuthUid: callerCanBo.AuthUid || callerUid,
          EmailLower: callerEmailLower,
          TaiKhoan: callerEmailLower,
          VaiTro: isBootstrapAdmin ? 'Admin' : (callerCanBo.VaiTro || 'TuVanVien')
        };
      }

      return jsonResponse(200, headers, {
        ok: true,
        laBootstrap: isBootstrapAdmin,
        vaiTro: effectiveVaiTro,
        canBo: syncedCanBo
      });
    }

    // Mọi action quản trị khác đều bắt buộc người gọi là Admin đang hoạt động hoặc Bootstrap Admin
    if (!isBootstrapAdmin && (!isCallerActiveCanBo || effectiveVaiTro !== 'Admin')) {
      return jsonResponse(403, headers, {
        ok: false,
        message: 'Chỉ Quản trị viên (Admin) đang hoạt động mới có quyền thực hiện thao tác này'
      });
    }

    const callerInfo = {
      uid: callerUid,
      emailLower: callerEmailLower,
      canBoId: callerCanBo ? callerCanBo.id : 'bootstrap_admin'
    };

    // =========================================================================
    // ACTION: 'create' (Tạo người dùng mới hoặc Cấp tài khoản Auth cho cán bộ cũ)
    // =========================================================================
    if (action === 'create') {
      const existingCanBoId = String(body.id || '').trim();
      const hoTen = String(body.HoTen || '').trim();
      const rawEmail = String(body.Email || '').trim();
      const emailLower = normalizeEmailLower(rawEmail);
      const soDienThoai = normalizePhone10(body.SoDienThoai || '');
      const idCoSo = String(body.ID_CoSo || '').trim();
      const vaiTro = String(body.VaiTro || 'TuVanVien').trim();
      const chucVu = String(body.ChucVu || 'Chuyên viên Tư vấn').trim();
      const matKhauTam = String(body.matKhauTam || '');
      let maCanBo = String(body.MaCanBo || '').trim().toUpperCase();

      if (!hoTen) {
        return jsonResponse(400, headers, { ok: false, message: 'Họ và tên không được để trống' });
      }
      if (!emailLower || !EMAIL_REGEX.test(emailLower)) {
        return jsonResponse(400, headers, { ok: false, message: 'Email đăng nhập không hợp lệ' });
      }
      if (!/^0\d{9}$/.test(soDienThoai)) {
        return jsonResponse(400, headers, { ok: false, message: 'Số điện thoại phải gồm 10 chữ số bắt đầu bằng số 0' });
      }
      if (!idCoSo) {
        return jsonResponse(400, headers, { ok: false, message: 'Vui lòng chọn cơ sở làm việc' });
      }
      if (!ALLOWED_VAI_TRO.includes(vaiTro)) {
        return jsonResponse(400, headers, { ok: false, message: 'Vai trò không hợp lệ' });
      }
      if (!matKhauTam || matKhauTam.length < 8) {
        return jsonResponse(400, headers, { ok: false, message: 'Mật khẩu tạm phải có ít nhất 8 ký tự' });
      }

      // Kiểm tra trùng email trong CanBo_TuyenSinh
      const duplicateCanBo = await findCanBoByEmail(db, emailLower);
      if (duplicateCanBo && duplicateCanBo.id !== existingCanBoId) {
        return jsonResponse(400, headers, {
          ok: false,
          message: `Email này đã được sử dụng cho cán bộ "${duplicateCanBo.HoTen || duplicateCanBo.id}"`
        });
      }

      // Kiểm tra email đã tồn tại trong Firebase Auth chưa
      try {
        const existingAuthUser = await auth.getUserByEmail(emailLower);
        if (existingAuthUser) {
          return jsonResponse(400, headers, {
            ok: false,
            message: 'Email này đã tồn tại trên Firebase Authentication. Không thể tạo trùng.'
          });
        }
      } catch (authLookupErr) {
        if (authLookupErr?.code !== 'auth/user-not-found') {
          throw authLookupErr;
        }
      }

      // Lấy tên cơ sở từ DmCoSo
      let tenCoSo = String(body.TenCoSo || '').trim();
      if (!tenCoSo && idCoSo !== 'ALL') {
        const csDoc = await db.collection('DmCoSo').doc(idCoSo).get();
        if (csDoc.exists) {
          tenCoSo = csDoc.data()?.TenCoSo || idCoSo;
        }
      }

      // Tạo tài khoản trên Firebase Auth
      const createdUserRecord = await auth.createUser({
        email: emailLower,
        password: matKhauTam,
        displayName: hoTen,
        disabled: false
      });

      const serverTs = admin.firestore.FieldValue.serverTimestamp();
      let targetDocRef;
      if (existingCanBoId) {
        targetDocRef = db.collection('CanBo_TuyenSinh').doc(existingCanBoId);
      } else {
        targetDocRef = db.collection('CanBo_TuyenSinh').doc();
      }

      if (!maCanBo) {
        maCanBo = existingCanBoId || `CB_${targetDocRef.id.slice(0, 6).toUpperCase()}`;
      }

      const canBoPayload = {
        ID_CoSo: idCoSo,
        TenCoSo: tenCoSo || idCoSo,
        MaCanBo: maCanBo,
        HoTen: hoTen,
        SoDienThoai: soDienThoai,
        Email: emailLower,
        EmailLower: emailLower,
        TaiKhoan: emailLower,
        ChucVu: chucVu,
        VaiTro: vaiTro,
        AuthUid: createdUserRecord.uid,
        BatBuocDoiMatKhau: true,
        TrangThai: 'HoatDong',
        NgayCapNhatCuoi: serverTs
      };

      if (!existingCanBoId) {
        canBoPayload.LanDangNhapCuoi = null;
      }

      await targetDocRef.set(canBoPayload, { merge: true });

      await writeAdminAuditLog(
        db,
        callerInfo,
        existingCanBoId ? 'CapTaiKhoanAuth' : 'TaoNguoiDung',
        targetDocRef.id,
        `${existingCanBoId ? 'Cấp tài khoản Auth' : 'Tạo người dùng mới'} cho ${hoTen} (Vai trò: ${vaiTro}, Cơ sở: ${tenCoSo || idCoSo})`
      );

      return jsonResponse(200, headers, {
        ok: true,
        id: targetDocRef.id,
        canBo: {
          id: targetDocRef.id,
          ...canBoPayload,
          LanDangNhapCuoi: null
        },
        matKhauTam
      });
    }

    // =========================================================================
    // ACTION: 'resetPassword' (Đặt lại mật khẩu tạm & bắt buộc đổi lần đăng nhập tới)
    // =========================================================================
    if (action === 'resetPassword') {
      const targetId = String(body.id || '').trim();
      const matKhauTam = String(body.matKhauTam || '');

      if (!targetId) {
        return jsonResponse(400, headers, { ok: false, message: 'Thiếu ID người dùng' });
      }
      if (!matKhauTam || matKhauTam.length < 8) {
        return jsonResponse(400, headers, { ok: false, message: 'Mật khẩu tạm phải có ít nhất 8 ký tự' });
      }

      const canBoRef = db.collection('CanBo_TuyenSinh').doc(targetId);
      const canBoSnap = await canBoRef.get();
      if (!canBoSnap.exists) {
        return jsonResponse(404, headers, { ok: false, message: 'Không tìm thấy bản ghi người dùng' });
      }

      const cbData = canBoSnap.data() || {};
      const emailLower = normalizeEmailLower(cbData.EmailLower || cbData.Email);
      if (!emailLower || !EMAIL_REGEX.test(emailLower)) {
        return jsonResponse(400, headers, {
          ok: false,
          message: 'Người dùng này chưa có email hợp lệ để đặt lại mật khẩu'
        });
      }

      let authUid = cbData.AuthUid || null;
      if (authUid) {
        try {
          await auth.updateUser(authUid, { password: matKhauTam });
        } catch (errUpdate) {
          if (errUpdate?.code === 'auth/user-not-found') {
            authUid = null;
          } else {
            throw errUpdate;
          }
        }
      }

      if (!authUid) {
        try {
          const foundUser = await auth.getUserByEmail(emailLower);
          authUid = foundUser.uid;
          await auth.updateUser(authUid, { password: matKhauTam });
        } catch (errByEmail) {
          if (errByEmail?.code === 'auth/user-not-found') {
            const newAuthUser = await auth.createUser({
              email: emailLower,
              password: matKhauTam,
              displayName: cbData.HoTen || '',
              disabled: (cbData.TrangThai || 'HoatDong') !== 'HoatDong'
            });
            authUid = newAuthUser.uid;
          } else {
            throw errByEmail;
          }
        }
      }

      await canBoRef.update({
        AuthUid: authUid,
        EmailLower: emailLower,
        TaiKhoan: emailLower,
        BatBuocDoiMatKhau: true,
        NgayCapNhatCuoi: admin.firestore.FieldValue.serverTimestamp()
      });

      await writeAdminAuditLog(
        db,
        callerInfo,
        'DatLaiMatKhau',
        targetId,
        `Đặt lại mật khẩu tạm cho ${cbData.HoTen || targetId} (bắt buộc đổi mật khẩu ở lần đăng nhập tới)`
      );

      return jsonResponse(200, headers, {
        ok: true,
        id: targetId,
        matKhauTam
      });
    }

    // =========================================================================
    // ACTION: 'setDisabled' (Khóa / Mở khóa người dùng)
    // =========================================================================
    if (action === 'setDisabled') {
      const targetId = String(body.id || '').trim();
      const khoa = Boolean(body.khoa);

      if (!targetId) {
        return jsonResponse(400, headers, { ok: false, message: 'Thiếu ID người dùng' });
      }

      const canBoRef = db.collection('CanBo_TuyenSinh').doc(targetId);
      const canBoSnap = await canBoRef.get();
      if (!canBoSnap.exists) {
        return jsonResponse(404, headers, { ok: false, message: 'Không tìm thấy bản ghi người dùng' });
      }

      const cbData = canBoSnap.data() || {};
      const targetEmailLower = normalizeEmailLower(cbData.EmailLower || cbData.Email);
      const targetVaiTro = cbData.VaiTro || 'TuVanVien';

      // Không cho Admin tự khóa chính mình
      if (
        khoa &&
        ((callerCanBo && callerCanBo.id === targetId) ||
          (targetEmailLower && targetEmailLower === callerEmailLower))
      ) {
        return jsonResponse(400, headers, {
          ok: false,
          message: 'Bạn không thể tự khóa tài khoản của chính mình'
        });
      }

      // Luôn giữ ít nhất 1 Admin hoạt động
      if (khoa && targetVaiTro === 'Admin') {
        const remainingAdmins = await countActiveAdmins(db, targetId);
        if (remainingAdmins < 1) {
          return jsonResponse(400, headers, {
            ok: false,
            message: 'Hệ thống phải có ít nhất 1 Quản trị viên (Admin) đang hoạt động'
          });
        }
      }

      let authUid = cbData.AuthUid || null;
      if (!authUid && targetEmailLower) {
        try {
          const u = await auth.getUserByEmail(targetEmailLower);
          authUid = u.uid;
        } catch (_e) {
          authUid = null;
        }
      }

      if (authUid) {
        try {
          await auth.updateUser(authUid, { disabled: khoa });
        } catch (errDisable) {
          if (errDisable?.code !== 'auth/user-not-found') {
            throw errDisable;
          }
        }
      }

      const nextTrangThai = khoa ? 'TamNgung' : 'HoatDong';
      const updatePayload = {
        TrangThai: nextTrangThai,
        NgayCapNhatCuoi: admin.firestore.FieldValue.serverTimestamp()
      };
      if (authUid && !cbData.AuthUid) {
        updatePayload.AuthUid = authUid;
      }
      await canBoRef.update(updatePayload);

      await writeAdminAuditLog(
        db,
        callerInfo,
        khoa ? 'KhoaTaiKhoan' : 'MoKhoaTaiKhoan',
        targetId,
        `${khoa ? 'Khóa (TamNgung)' : 'Mở khóa (HoatDong)'} tài khoản ${cbData.HoTen || targetId}`
      );

      return jsonResponse(200, headers, {
        ok: true,
        id: targetId,
        TrangThai: nextTrangThai
      });
    }

    // =========================================================================
    // ACTION: 'update' (Cập nhật thông tin, vai trò, cơ sở của người dùng)
    // =========================================================================
    if (action === 'update') {
      const targetId = String(body.id || '').trim();
      if (!targetId) {
        return jsonResponse(400, headers, { ok: false, message: 'Thiếu ID người dùng cần cập nhật' });
      }

      const canBoRef = db.collection('CanBo_TuyenSinh').doc(targetId);
      const canBoSnap = await canBoRef.get();
      if (!canBoSnap.exists) {
        return jsonResponse(404, headers, { ok: false, message: 'Không tìm thấy bản ghi người dùng' });
      }

      const cbData = canBoSnap.data() || {};
      const hoTen = body.HoTen !== undefined ? String(body.HoTen).trim() : String(cbData.HoTen || '').trim();
      const rawEmail = body.Email !== undefined ? String(body.Email).trim() : String(cbData.Email || cbData.EmailLower || '').trim();
      const emailLower = normalizeEmailLower(rawEmail);
      const soDienThoai = body.SoDienThoai !== undefined ? normalizePhone10(body.SoDienThoai) : normalizePhone10(cbData.SoDienThoai || '');
      const idCoSo = body.ID_CoSo !== undefined ? String(body.ID_CoSo).trim() : String(cbData.ID_CoSo || '').trim();
      const vaiTro = body.VaiTro !== undefined ? String(body.VaiTro).trim() : String(cbData.VaiTro || 'TuVanVien').trim();
      const chucVu = body.ChucVu !== undefined ? String(body.ChucVu).trim() : String(cbData.ChucVu || '').trim();
      const maCanBo = body.MaCanBo !== undefined ? String(body.MaCanBo).trim().toUpperCase() : String(cbData.MaCanBo || targetId).trim().toUpperCase();

      if (!hoTen) {
        return jsonResponse(400, headers, { ok: false, message: 'Họ và tên không được để trống' });
      }
      if (!emailLower || !EMAIL_REGEX.test(emailLower)) {
        return jsonResponse(400, headers, { ok: false, message: 'Email đăng nhập không hợp lệ' });
      }
      if (!/^0\d{9}$/.test(soDienThoai)) {
        return jsonResponse(400, headers, { ok: false, message: 'Số điện thoại phải gồm 10 chữ số bắt đầu bằng số 0' });
      }
      if (!idCoSo) {
        return jsonResponse(400, headers, { ok: false, message: 'Vui lòng chọn cơ sở làm việc' });
      }
      if (!ALLOWED_VAI_TRO.includes(vaiTro)) {
        return jsonResponse(400, headers, { ok: false, message: 'Vai trò không hợp lệ' });
      }

      const currentEmailLower = normalizeEmailLower(cbData.EmailLower || cbData.Email);
      const isEditingSelf =
        (callerCanBo && callerCanBo.id === targetId) ||
        (currentEmailLower && currentEmailLower === callerEmailLower);

      // Không cho Admin tự hạ quyền của chính mình
      if (isEditingSelf && vaiTro !== 'Admin') {
        return jsonResponse(400, headers, {
          ok: false,
          message: 'Bạn không thể tự hạ quyền Quản trị viên (Admin) của chính mình'
        });
      }

      // Nếu hạ quyền 1 Admin khác, phải đảm bảo còn ít nhất 1 Admin đang hoạt động
      const oldVaiTro = cbData.VaiTro || 'TuVanVien';
      if (oldVaiTro === 'Admin' && vaiTro !== 'Admin') {
        const remainingAdmins = await countActiveAdmins(db, targetId);
        if (remainingAdmins < 1) {
          return jsonResponse(400, headers, {
            ok: false,
            message: 'Hệ thống phải có ít nhất 1 Quản trị viên (Admin) đang hoạt động'
          });
        }
      }

      // Kiểm tra trùng email với cán bộ khác
      const duplicateCanBo = await findCanBoByEmail(db, emailLower);
      if (duplicateCanBo && duplicateCanBo.id !== targetId) {
        return jsonResponse(400, headers, {
          ok: false,
          message: `Email này đã được sử dụng cho cán bộ "${duplicateCanBo.HoTen || duplicateCanBo.id}"`
        });
      }

      // Lấy TenCoSo
      let tenCoSo = String(body.TenCoSo || '').trim();
      if (!tenCoSo && idCoSo !== 'ALL') {
        const csDoc = await db.collection('DmCoSo').doc(idCoSo).get();
        if (csDoc.exists) {
          tenCoSo = csDoc.data()?.TenCoSo || idCoSo;
        }
      }
      if (!tenCoSo) {
        tenCoSo = cbData.TenCoSo || idCoSo;
      }

      // Đồng bộ lên Firebase Auth nếu đã có AuthUid
      let authUid = cbData.AuthUid || null;
      if (authUid) {
        const authUpdates = { displayName: hoTen };
        if (emailLower !== currentEmailLower) {
          authUpdates.email = emailLower;
        }
        try {
          await auth.updateUser(authUid, authUpdates);
        } catch (authUpdErr) {
          if (authUpdErr?.code === 'auth/email-already-exists') {
            return jsonResponse(400, headers, {
              ok: false,
              message: 'Email mới đã tồn tại trên Firebase Authentication'
            });
          }
          if (authUpdErr?.code !== 'auth/user-not-found') {
            throw authUpdErr;
          }
        }
      }

      const updateData = {
        HoTen: hoTen,
        Email: emailLower,
        EmailLower: emailLower,
        TaiKhoan: emailLower,
        SoDienThoai: soDienThoai,
        ID_CoSo: idCoSo,
        TenCoSo: tenCoSo,
        VaiTro: vaiTro,
        ChucVu: chucVu,
        MaCanBo: maCanBo,
        NgayCapNhatCuoi: admin.firestore.FieldValue.serverTimestamp()
      };

      await canBoRef.update(updateData);

      await writeAdminAuditLog(
        db,
        callerInfo,
        'CapNhatNguoiDung',
        targetId,
        `Cập nhật thông tin người dùng ${hoTen} (Vai trò: ${oldVaiTro} -> ${vaiTro}, Cơ sở: ${tenCoSo})`
      );

      return jsonResponse(200, headers, {
        ok: true,
        id: targetId,
        canBo: {
          id: targetId,
          ...cbData,
          ...updateData
        }
      });
    }

    return jsonResponse(400, headers, {
      ok: false,
      message: `Action không hợp lệ: ${action}`
    });
  } catch (err) {
    return jsonResponse(500, headers, {
      ok: false,
      message: err?.message || 'Lỗi máy chủ khi xử lý quản trị người dùng'
    });
  }
};
