'use strict';

const admin = require('firebase-admin');

const VN_TIMEZONE = 'Asia/Ho_Chi_Minh';
const ALLOWED_LOAI_TIN = ['XepLop', 'NhacT3', 'NhacT1'];

let firestoreDb = null;

function getDb() {
  if (firestoreDb) return firestoreDb;

  if (!admin.apps.length) {
    const rawSa = process.env.FIREBASE_SERVICE_ACCOUNT;
    if (!rawSa) {
      throw new Error('Thiếu biến môi trường FIREBASE_SERVICE_ACCOUNT');
    }
    let serviceAccount;
    try {
      serviceAccount = JSON.parse(rawSa);
      if (serviceAccount && typeof serviceAccount.private_key === 'string') {
        serviceAccount.private_key = serviceAccount.private_key.replace(/\\n/g, '\n');
      }
    } catch (err) {
      throw new Error('FIREBASE_SERVICE_ACCOUNT không phải JSON hợp lệ: ' + err.message);
    }

    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount)
    });
  }

  firestoreDb = admin.firestore();
  return firestoreDb;
}

function getAuth() {
  getDb();
  return admin.auth();
}

/**
 * Chuyển đổi an toàn mọi kiểu giá trị ngày/giờ (Firestore Timestamp, Date, chuỗi yyyy-MM-dd, dd/MM/yyyy, số)
 * sang đối tượng Date hợp lệ. Trả về null nếu không hợp lệ.
 */
function toDateSafe(val) {
  if (val === null || val === undefined || val === '') return null;
  if (val instanceof Date) {
    return Number.isNaN(val.getTime()) ? null : val;
  }
  if (typeof val.toDate === 'function') {
    const d = val.toDate();
    return d instanceof Date && !Number.isNaN(d.getTime()) ? d : null;
  }
  if (typeof val === 'object') {
    const sec = val.seconds !== undefined ? val.seconds : val._seconds;
    const nano = val.nanoseconds !== undefined ? val.nanoseconds : val._nanoseconds || 0;
    if (typeof sec === 'number') {
      const d = new Date(sec * 1000 + Math.floor(nano / 1e6));
      return Number.isNaN(d.getTime()) ? null : d;
    }
  }
  if (typeof val === 'number') {
    const d = new Date(val);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  if (typeof val === 'string') {
    const str = val.trim();
    if (!str) return null;

    // Định dạng yyyy-MM-dd -> hiểu theo 00:00:00 múi giờ Asia/Ho_Chi_Minh (+07:00)
    const ymdMatch = str.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
    if (ymdMatch) {
      const yyyy = ymdMatch[1];
      const mm = String(ymdMatch[2]).padStart(2, '0');
      const dd = String(ymdMatch[3]).padStart(2, '0');
      const d = new Date(`${yyyy}-${mm}-${dd}T00:00:00+07:00`);
      return Number.isNaN(d.getTime()) ? null : d;
    }

    // Định dạng dd/MM/yyyy -> hiểu theo 00:00:00 múi giờ Asia/Ho_Chi_Minh (+07:00)
    const dmyMatch = str.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
    if (dmyMatch) {
      const dd = String(dmyMatch[1]).padStart(2, '0');
      const mm = String(dmyMatch[2]).padStart(2, '0');
      const yyyy = dmyMatch[3];
      const d = new Date(`${yyyy}-${mm}-${dd}T00:00:00+07:00`);
      return Number.isNaN(d.getTime()) ? null : d;
    }

    const parsed = new Date(str);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }
  return null;
}

/**
 * Tách thành phần năm, tháng, ngày theo múi giờ Asia/Ho_Chi_Minh (dương lịch, bỏ giờ).
 */
function getVNDateParts(val) {
  const d = toDateSafe(val);
  if (!d) return null;

  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: VN_TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  });
  const parts = formatter.formatToParts(d);
  const yyyy = parts.find(p => p.type === 'year')?.value || '';
  const mm = parts.find(p => p.type === 'month')?.value || '';
  const dd = parts.find(p => p.type === 'day')?.value || '';
  if (!yyyy || !mm || !dd) return null;

  const year = Number(yyyy);
  const month = Number(mm);
  const day = Number(dd);
  const utcMidnightMs = Date.UTC(year, month - 1, day);
  const dayOfWeek = new Date(utcMidnightMs).getUTCDay(); // 0 = CN, 1 = Thứ Hai, ..., 6 = Thứ Bảy

  const THU_VI = [
    'Chủ nhật',
    'Thứ Hai',
    'Thứ Ba',
    'Thứ Tư',
    'Thứ Năm',
    'Thứ Sáu',
    'Thứ Bảy'
  ];

  return {
    year,
    month,
    day,
    yyyy,
    mm,
    dd,
    ymdDash: `${yyyy}-${mm}-${dd}`,
    ymdCompact: `${yyyy}${mm}${dd}`,
    dmySlash: `${dd}/${mm}/${yyyy}`,
    utcMidnightMs,
    thuVi: THU_VI[dayOfWeek] || ''
  };
}

/**
 * Tính hiệu số ngày dương lịch theo múi giờ Asia/Ho_Chi_Minh (bỏ giờ):
 * trả về (targetDate - baseDate) tính bằng số ngày nguyên.
 */
function diffCalendarDaysVN(targetVal, baseVal = new Date()) {
  const targetParts = getVNDateParts(targetVal);
  const baseParts = getVNDateParts(baseVal);
  if (!targetParts || !baseParts) return null;
  const diffMs = targetParts.utcMidnightMs - baseParts.utcMidnightMs;
  return Math.round(diffMs / 86400000);
}

/**
 * Chuẩn hóa số điện thoại Việt Nam sang định dạng ZNS Quốc tế:
 * 0912345678 -> 84912345678
 */
function normalizePhone(raw) {
  if (raw === null || raw === undefined) return '';
  let cleaned = String(raw)
    .trim()
    .replace(/^\+/, '')
    .replace(/[\s.\-()]/g, '');

  if (/^0\d{9}$/.test(cleaned)) {
    return '84' + cleaned.slice(1);
  }
  if (/^[35789]\d{8}$/.test(cleaned)) {
    return '84' + cleaned;
  }
  return cleaned;
}

/**
 * Kiểm tra số điện thoại sau khi normalizePhone có đúng định dạng di động VN 84xxxxxxxxx (11 chữ số) hay không.
 */
function isValidPhone84(phone84) {
  if (!phone84 || typeof phone84 !== 'string') return false;
  return /^84[35789]\d{8}$/.test(phone84);
}

function safeStr(val) {
  if (val === null || val === undefined) return '';
  return String(val);
}

/**
 * Tạo đối tượng templateData trả đúng 15 khóa theo hợp đồng ZNS.
 * Giá trị thiếu luôn trả về chuỗi rỗng "", tuyệt đối không có undefined/null.
 */
function buildTemplateData(hocVien = {}, lop = {}, coSo = {}, canBo = {}) {
  const hv = hocVien || {};
  const lp = lop || {};
  const cs = coSo || {};
  const cb = canBo || {};

  const hvId = safeStr(hv.id || hv.ID_HocVien || '');
  const siteUrl = safeStr(process.env.SITE_URL || '').replace(/\/+$/, '');
  const linkXacNhan = hvId ? `${siteUrl}/?mode=xacnhan&hv=${encodeURIComponent(hvId)}` : '';

  const kgParts = getVNDateParts(lp.NgayKhaiGiangDuKien);
  const ngayKhaiGiang = kgParts ? kgParts.dmySlash : '';
  const thuKhaiGiang = kgParts ? kgParts.thuVi : '';

  const daysLeft = kgParts ? diffCalendarDaysVN(lp.NgayKhaiGiangDuKien, new Date()) : null;
  const soNgayConLai = daysLeft !== null && daysLeft !== undefined ? String(Math.max(0, daysLeft)) : '';

  let tenNghe = safeStr(lp.TenNghe || '');
  if (!tenNghe && Array.isArray(hv.TenNganhQuanTam) && hv.TenNganhQuanTam.length > 0) {
    tenNghe = safeStr(hv.TenNganhQuanTam.join(', '));
  }

  return {
    ten_hoc_vien: safeStr(hv.HoTen || hv.TenHocVien || ''),
    ma_ho_so: safeStr(hv.MaThamChieu || hv.MaHocVien || hvId),
    ten_lop: safeStr(lp.TenLop || hv.TenLopHienTai || ''),
    ma_lop: safeStr(lp.MaLop || lp.id || hv.ID_LopHienTai || ''),
    ten_nghe: tenNghe,
    ten_co_so: safeStr(cs.TenCoSo || lp.TenCoSo || hv.TenCoSo || ''),
    dia_chi_co_so: safeStr(cs.DiaChi || lp.DiaChiCoSo || ''),
    hotline_co_so: safeStr(cs.SoDienThoai || cs.Hotline || ''),
    ngay_khai_giang: ngayKhaiGiang,
    thu_khai_giang: thuKhaiGiang,
    lich_hoc: safeStr(lp.LichHocCoDinh || lp.LichHoc || ''),
    so_ngay_con_lai: soNgayConLai,
    ten_can_bo: safeStr(cb.HoTen || hv.TenCanBoPhuTrach || ''),
    sdt_can_bo: safeStr(cb.SoDienThoai || cb.SDT || ''),
    link_xac_nhan: linkXacNhan
  };
}

function buildNhatKyZaloDocId(hocVienId, lopId, loaiTin, ngayKhaiGiangVal) {
  const parts = getVNDateParts(ngayKhaiGiangVal);
  const ymd = parts ? parts.ymdCompact : '00000000';
  return `${hocVienId}_${lopId}_${loaiTin}_${ymd}`;
}

function resolveDefaultDryRun(explicitDryRun, zaloConfig) {
  if (typeof explicitDryRun === 'boolean') return explicitDryRun;
  if (zaloConfig && typeof zaloConfig.dryRun === 'boolean') return zaloConfig.dryRun;
  const envVal = process.env.ZALO_DEFAULT_DRY_RUN;
  if (envVal !== undefined && envVal !== '') {
    return ['1', 'true', 'yes'].includes(String(envVal).trim().toLowerCase());
  }
  return false;
}

/**
 * Lấy URL Web App Apps Script: ưu tiên CauHinh/zalo.webhookUrl, nếu rỗng thì dùng process.env.APPS_SCRIPT_URL.
 */
function resolveWebhookUrl(zaloConfig = {}) {
  const fromConfig = safeStr(zaloConfig?.webhookUrl || '').trim();
  if (fromConfig) return fromConfig;
  return safeStr(process.env.APPS_SCRIPT_URL || '').trim();
}

/**
 * Lấy ZALO_SHARED_SECRET: chỉ lấy từ process.env.ZALO_SHARED_SECRET, tuyệt đối KHÔNG đọc từ Firestore.
 */
function resolveSharedSecret() {
  return safeStr(process.env.ZALO_SHARED_SECRET || '').trim();
}

/**
 * Lấy mã template ZNS từ CauHinh/zalo theo loaiTin (templateXepLop / templateNhacT3 / templateNhacT1).
 */
function resolveTemplateId(loaiTin, zaloConfig = {}) {
  if (!zaloConfig) return '';
  if (loaiTin === 'XepLop') return safeStr(zaloConfig.templateXepLop || '').trim();
  if (loaiTin === 'NhacT3') return safeStr(zaloConfig.templateNhacT3 || '').trim();
  if (loaiTin === 'NhacT1') return safeStr(zaloConfig.templateNhacT1 || '').trim();
  return '';
}

/**
 * Kiểm tra công tắc bật/tắt theo từng loại tin trong CauHinh/zalo (batXepLop, batNhacT3, batNhacT1).
 */
function isLoaiTinEnabled(loaiTin, zaloConfig = {}) {
  if (!zaloConfig) return true;
  if (loaiTin === 'XepLop' && zaloConfig.batXepLop === false) return false;
  if (loaiTin === 'NhacT3' && zaloConfig.batNhacT3 === false) return false;
  if (loaiTin === 'NhacT1' && zaloConfig.batNhacT1 === false) return false;
  return true;
}

/**
 * Gửi POST JSON tới Apps Script URL với timeout 20 giây, thử lại 1 lần nếu gặp lỗi mạng hoặc HTTP 5xx.
 */
async function postToAppsScriptWithRetry(url, payload, timeoutMs = 20000) {
  let lastError = null;

  for (let attempt = 1; attempt <= 2; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(payload),
        signal: controller.signal
      });
      clearTimeout(timer);

      if (response.status >= 500 && attempt < 2) {
        lastError = new Error(`HTTP ${response.status} từ Apps Script`);
        lastError.code = `HTTP_${response.status}`;
        continue;
      }

      const rawText = await response.text();
      let data = null;
      try {
        data = rawText ? JSON.parse(rawText) : {};
      } catch (_e) {
        data = { rawText };
      }

      if (!response.ok) {
        const err = new Error(
          data?.message || data?.error || `Apps Script trả về HTTP ${response.status}`
        );
        err.code = data?.errorCode || data?.code || `HTTP_${response.status}`;
        throw err;
      }

      return data;
    } catch (err) {
      clearTimeout(timer);
      lastError = err;
      const isAbort = err && (err.name === 'AbortError' || /aborted|timeout/i.test(err.message || ''));
      if (isAbort) {
        lastError = new Error('Quá thời gian chờ 20 giây khi gọi Apps Script (Timeout)');
        lastError.code = 'TIMEOUT_20S';
      }
      // Chỉ thử lại 1 lần với lỗi mạng / timeout / 5xx
      const isClientHttpErr =
        lastError.code &&
        /^HTTP_4\d\d$/.test(String(lastError.code));
      if (attempt < 2 && !isClientHttpErr) {
        continue;
      }
      throw lastError;
    }
  }

  throw lastError || new Error('Lỗi không xác định khi gọi Apps Script');
}

/**
 * Tạo NhiemVu_ChamSoc (LoaiNhiemVu: 'GoiNhacLich', TrangThai: 'ChoXuLy', ThoiGianHenGoi = hiện tại,
 * gán ID_CanBo) khi gửi Zalo bị 'Loi' hoặc 'BoQua' do SĐT sai định dạng, tránh tạo trùng.
 */
async function ensureGoiNhacLichTask(db, hocVien, lop, loaiTin, reasonText) {
  if (!hocVien || !hocVien.id) return false;
  const hvStatus = hocVien.TrangThai || '';
  if (hvStatus === 'Huy' || hvStatus === 'MatKetNoi') return false;

  const existingSnap = await db
    .collection('NhiemVu_ChamSoc')
    .where('ID_HocVien', '==', hocVien.id)
    .where('LoaiNhiemVu', '==', 'GoiNhacLich')
    .where('TrangThai', '==', 'ChoXuLy')
    .limit(1)
    .get();

  if (!existingSnap.empty) {
    return false;
  }

  const nowTs = admin.firestore.FieldValue.serverTimestamp();
  const taskRef = db.collection('NhiemVu_ChamSoc').doc();
  await taskRef.set({
    ID_HocVien: hocVien.id,
    TenHocVien: safeStr(hocVien.HoTen || hocVien.TenHocVien || ''),
    SoDienThoai: safeStr(hocVien.SoDienThoai || ''),
    ID_CanBo: safeStr(hocVien.ID_CanBoPhuTrach || hocVien.ID_CanBo || ''),
    TenCanBo: safeStr(hocVien.TenCanBoPhuTrach || hocVien.TenCanBo || ''),
    ID_CoSo: safeStr(lop?.ID_CoSo || hocVien.ID_CoSoMongMuon || ''),
    ID_Lop: safeStr(lop?.id || hocVien.ID_LopHienTai || ''),
    TenLop: safeStr(lop?.TenLop || hocVien.TenLopHienTai || ''),
    LoaiNhiemVu: 'GoiNhacLich',
    ThoiGianHenGoi: nowTs,
    NoiDungCanGoi: `Gọi nhắc lịch học (${loaiTin}) do chưa gửi được Zalo tự động: ${reasonText}`,
    TrangThai: 'ChoXuLy',
    PhanHangLead: safeStr(hocVien.PhanHangLead || 'Warm'),
    NgayHoanThanh: null,
    NgayTao: nowTs,
    NgayCapNhatCuoi: nowTs
  });

  return true;
}

/**
 * Gửi tin Zalo tự động theo đúng quy trình 6 bước:
 * (1) Đọc CauHinh/zalo, chỉ gửi khi enabled === true (thiếu doc hoặc thiếu field = tắt -> BoQua 'Tắt tự động');
 *     kiểm tra batXepLop/batNhacT3/batNhacT1 theo loaiTin (thiếu field = true, tắt -> BoQua 'Loại tin đang tắt')
 * (2) Doc ID = {ID_HocVien}_{ID_Lop}_{LoaiTin}_{yyyyMMdd khai giảng}; trong transaction chống trùng:
 *     - TrangThai == 'DaGui' -> dừng (alreadySent)
 *     - TrangThai == 'DryRun': nếu effectiveDryRun == true thì dừng; nếu effectiveDryRun == false thì cho phép gửi lại (ghi đè sang ChoGui)
 *     - TrangThai == 'ChoGui' có ThoiGianBatDau cách hiện tại dưới 2 phút -> dừng với trangThai 'DangXuLy'; từ 2 phút trở lên thì xử lý lại
 *     - Khi chuyển sang ChoGui luôn ghi ThoiGianBatDau (Timestamp)
 * (3) Kiểm tra điều kiện BoQua (hocVien thiếu / Huy / MatKetNoi, lop thiếu / !== SapKhaiGiang,
 *     không có PhieuDangKy_Hoc DangHieuLuc khớp học viên + lớp, hoặc SoDienThoai sai định dạng)
 * (4) Lấy templateId theo loaiTin từ CauHinh/zalo (templateXepLop/templateNhacT3/templateNhacT1);
 *     nếu thiếu templateId thì ghi Loi với MaLoi 'MISSING_TEMPLATE_ID' và dừng, không gọi Apps Script.
 *     POST JSON tới Apps Script URL {action:'SEND_ZNS', secret, loaiTin, templateId, trackingId, dryRun, phone, templateData}
 *     với timeout 20 giây, thử lại 1 lần với lỗi mạng/5xx
 * (5) Cập nhật TrangThai DaGui / Loi (MaLoi, GhiChu) / DryRun, ThoiGianGui
 * (6) Khi TrangThai == 'Loi' hoặc BoQua do SĐT lỗi, tạo NhiemVu_ChamSoc (LoaiNhiemVu: 'GoiNhacLich',
 *     TrangThai: 'ChoXuLy', ThoiGianHenGoi = hiện tại, gán ID_CanBo), tránh tạo trùng
 */
async function guiTin(loaiTin, hocVienId, lopId, options = {}) {
  if (!ALLOWED_LOAI_TIN.includes(loaiTin)) {
    throw new Error(`LoaiTin không hợp lệ: ${loaiTin}`);
  }
  if (!hocVienId || !lopId) {
    throw new Error('Thiếu hocVienId hoặc lopId');
  }

  const db = getDb();
  const serverTimestamp = admin.firestore.FieldValue.serverTimestamp;

  // Đọc song song CauHinh/zalo, HocVien, LopKhaiGiang
  const [zaloCfgSnap, hvSnap, lopSnap] = await Promise.all([
    db.collection('CauHinh').doc('zalo').get(),
    db.collection('HocVien').doc(hocVienId).get(),
    db.collection('LopKhaiGiang').doc(lopId).get()
  ]);

  const zaloConfig = zaloCfgSnap.exists ? zaloCfgSnap.data() || {} : {};
  const hocVien = hvSnap.exists ? { id: hvSnap.id, ...hvSnap.data() } : null;
  const lop = lopSnap.exists ? { id: lopSnap.id, ...lopSnap.data() } : null;

  const kgParts = lop ? getVNDateParts(lop.NgayKhaiGiangDuKien) : null;
  const ngayKhaiGiangYmd = kgParts ? kgParts.ymdDash : '';
  const docId = buildNhatKyZaloDocId(hocVienId, lopId, loaiTin, lop?.NgayKhaiGiangDuKien);
  const nhatKyRef = db.collection('NhatKy_Zalo').doc(docId);

  const effectiveDryRun = resolveDefaultDryRun(options.dryRun, zaloConfig);
  const normalizedPhone = normalizePhone(hocVien?.SoDienThoai || '');

  // (1) Chỉ gửi khi CauHinh/zalo.enabled === true (thiếu doc hoặc thiếu field = tắt, ghi BoQua 'Tắt tự động').
  //     Kiểm tra batXepLop/batNhacT3/batNhacT1 theo loaiTin (thiếu field = true); tắt thì BoQua 'Loại tin đang tắt'.
  const isMasterEnabled = Boolean(zaloCfgSnap.exists && zaloConfig && zaloConfig.enabled === true);
  const isTypeEnabled = isLoaiTinEnabled(loaiTin, zaloConfig);

  if (!isMasterEnabled || !isTypeEnabled) {
    const offNote = !isMasterEnabled ? 'Tắt tự động' : 'Loại tin đang tắt';
    await nhatKyRef.set(
      {
        ID_HocVien: hocVienId,
        TenHocVien: safeStr(hocVien?.HoTen || ''),
        SoDienThoai: normalizedPhone || safeStr(hocVien?.SoDienThoai || ''),
        ID_Lop: lopId,
        MaLop: safeStr(lop?.MaLop || ''),
        TenLop: safeStr(lop?.TenLop || ''),
        ID_CoSo: safeStr(lop?.ID_CoSo || hocVien?.ID_CoSoMongMuon || ''),
        LoaiTin: loaiTin,
        NgayKhaiGiang: ngayKhaiGiangYmd,
        TrangThai: 'BoQua',
        MaLoi: null,
        GhiChu: offNote,
        NgayCapNhatCuoi: serverTimestamp()
      },
      { merge: true }
    );
    return {
      ok: false,
      trangThai: 'BoQua',
      docId,
      ghiChu: offNote
    };
  }

  // (2) Chống trùng trong transaction:
  //     - TrangThai == 'DaGui' -> dừng (alreadySent)
  //     - TrangThai == 'DryRun': nếu effectiveDryRun == true thì dừng; nếu effectiveDryRun == false thì CHO PHÉP gửi lại (ghi đè sang ChoGui)
  //     - TrangThai == 'ChoGui' có ThoiGianBatDau cách hiện tại dưới 2 phút -> dừng với trangThai 'DangXuLy'; từ 2 phút trở lên thì xử lý lại
  //     - Khi chuyển sang ChoGui luôn ghi ThoiGianBatDau (Timestamp)
  const txResult = await db.runTransaction(async transaction => {
    const snap = await transaction.get(nhatKyRef);
    if (snap.exists) {
      const existingData = snap.data() || {};
      if (existingData.TrangThai === 'DaGui') {
        return {
          stop: true,
          alreadySent: true,
          trangThai: 'DaGui',
          ghiChu: existingData.GhiChu || 'Đã gửi trước đó'
        };
      }
      if (existingData.TrangThai === 'DryRun') {
        if (effectiveDryRun === true) {
          return {
            stop: true,
            alreadySent: true,
            trangThai: 'DryRun',
            ghiChu: existingData.GhiChu || 'Đã chạy thử trước đó'
          };
        }
        // effectiveDryRun === false -> CHO PHÉP gửi lại (ghi đè sang ChoGui)
      }
      if (existingData.TrangThai === 'ChoGui') {
        const startedAt = toDateSafe(existingData.ThoiGianBatDau);
        if (startedAt && Date.now() - startedAt.getTime() < 2 * 60 * 1000) {
          return {
            stop: true,
            alreadySent: false,
            trangThai: 'DangXuLy',
            ghiChu: 'Đang xử lý (chưa quá 2 phút)'
          };
        }
        // Từ 2 phút trở lên (hoặc thiếu ThoiGianBatDau) -> xử lý lại
      }
    }

    const nowTs = admin.firestore.Timestamp.now();
    const basePayload = {
      ID_HocVien: hocVienId,
      TenHocVien: safeStr(hocVien?.HoTen || ''),
      SoDienThoai: normalizedPhone || safeStr(hocVien?.SoDienThoai || ''),
      ID_Lop: lopId,
      MaLop: safeStr(lop?.MaLop || ''),
      TenLop: safeStr(lop?.TenLop || ''),
      ID_CoSo: safeStr(lop?.ID_CoSo || hocVien?.ID_CoSoMongMuon || ''),
      LoaiTin: loaiTin,
      NgayKhaiGiang: ngayKhaiGiangYmd,
      TrangThai: 'ChoGui',
      ThoiGianBatDau: nowTs,
      DryRun: effectiveDryRun,
      MaLoi: null,
      GhiChu: '',
      NgayCapNhatCuoi: serverTimestamp()
    };

    if (!snap.exists) {
      basePayload.NgayTao = serverTimestamp();
      transaction.set(nhatKyRef, basePayload);
    } else {
      transaction.update(nhatKyRef, basePayload);
    }

    return { stop: false, alreadySent: false };
  });

  if (txResult.stop) {
    return {
      ok: Boolean(txResult.alreadySent),
      alreadySent: Boolean(txResult.alreadySent),
      trangThai: txResult.trangThai,
      docId,
      ghiChu: txResult.ghiChu
    };
  }

  // (3) Kiểm tra các điều kiện BoQua
  let skipReason = null;
  let isPhoneInvalid = false;

  if (!hocVien) {
    skipReason = 'Không tìm thấy hồ sơ học viên';
  } else if (hocVien.LaDuLieuMau === true || lop?.LaDuLieuMau === true) {
    skipReason = 'Bỏ qua bản ghi dữ liệu mẫu (LaDuLieuMau)';
  } else if (['Huy', 'MatKetNoi'].includes(hocVien.TrangThai)) {
    skipReason = `Học viên ở trạng thái ${hocVien.TrangThai}`;
  } else if (!lop) {
    skipReason = 'Không tìm thấy lớp khai giảng';
  } else if (lop.TrangThai !== 'SapKhaiGiang') {
    skipReason = `Lớp không ở trạng thái SapKhaiGiang (${lop.TrangThai || 'N/A'})`;
  } else {
    // Kiểm tra có PhieuDangKy_Hoc 'DangHieuLuc' khớp học viên + lớp
    const phieuSnap = await db
      .collection('PhieuDangKy_Hoc')
      .where('ID_HocVien', '==', hocVienId)
      .where('ID_Lop', '==', lopId)
      .where('TrangThaiPhieu', '==', 'DangHieuLuc')
      .limit(1)
      .get();

    if (phieuSnap.empty) {
      skipReason = 'Không có PhieuDangKy_Hoc DangHieuLuc khớp học viên và lớp';
    } else if (!isValidPhone84(normalizedPhone)) {
      skipReason = `Số điện thoại sai định dạng (${hocVien.SoDienThoai || 'trống'})`;
      isPhoneInvalid = true;
    }
  }

  if (skipReason) {
    await nhatKyRef.update({
      TrangThai: 'BoQua',
      MaLoi: isPhoneInvalid ? 'INVALID_PHONE' : null,
      GhiChu: skipReason,
      NgayCapNhatCuoi: serverTimestamp()
    });

    if (isPhoneInvalid && hocVien) {
      await ensureGoiNhacLichTask(db, hocVien, lop, loaiTin, skipReason);
    }

    return {
      ok: false,
      trangThai: 'BoQua',
      docId,
      ghiChu: skipReason
    };
  }

  // Đọc thêm DmCoSo, CanBo_TuyenSinh, DmNghe để tạo templateData đủ 15 khóa
  const coSoId = lop.ID_CoSo || hocVien.ID_CoSoMongMuon || '';
  const canBoId = hocVien.ID_CanBoPhuTrach || '';
  const ngheId = lop.ID_Nghe || '';

  const [coSoSnap, canBoSnap, ngheSnap] = await Promise.all([
    coSoId ? db.collection('DmCoSo').doc(coSoId).get() : Promise.resolve(null),
    canBoId ? db.collection('CanBo_TuyenSinh').doc(canBoId).get() : Promise.resolve(null),
    !lop.TenNghe && ngheId ? db.collection('DmNghe').doc(ngheId).get() : Promise.resolve(null)
  ]);

  const coSo = coSoSnap && coSoSnap.exists ? { id: coSoSnap.id, ...coSoSnap.data() } : {};
  const canBo = canBoSnap && canBoSnap.exists ? { id: canBoSnap.id, ...canBoSnap.data() } : {};
  if (!lop.TenNghe && ngheSnap && ngheSnap.exists) {
    lop.TenNghe = ngheSnap.data()?.TenNghe || '';
  }

  const templateData = buildTemplateData(hocVien, lop, coSo, canBo);

  // Kiểm tra templateId theo loaiTin từ CauHinh/zalo (templateXepLop / templateNhacT3 / templateNhacT1)
  const templateId = resolveTemplateId(loaiTin, zaloConfig);
  if (!templateId) {
    const errMsg = `Thiếu mã template ZNS cho loại tin ${loaiTin}`;
    await nhatKyRef.update({
      TrangThai: 'Loi',
      MaLoi: 'MISSING_TEMPLATE_ID',
      GhiChu: errMsg,
      TemplateData: templateData,
      ThoiGianGui: serverTimestamp(),
      NgayCapNhatCuoi: serverTimestamp()
    });
    await ensureGoiNhacLichTask(db, hocVien, lop, loaiTin, `MISSING_TEMPLATE_ID: ${errMsg}`);
    return {
      ok: false,
      trangThai: 'Loi',
      docId,
      maLoi: 'MISSING_TEMPLATE_ID',
      ghiChu: errMsg
    };
  }

  // Hỗ trợ chế độ ?dry=1 (chỉ ghi DryRun, không gọi Apps Script)
  if (options.skipAppsScriptOnDryRun && effectiveDryRun) {
    await nhatKyRef.update({
      TrangThai: 'DryRun',
      DryRun: true,
      MaLoi: null,
      GhiChu: 'DryRun (?dry=1, không gọi Apps Script)',
      TemplateId: templateId,
      TemplateData: templateData,
      ThoiGianGui: serverTimestamp(),
      NgayCapNhatCuoi: serverTimestamp()
    });

    return {
      ok: true,
      trangThai: 'DryRun',
      docId,
      templateId,
      templateData
    };
  }

  // (4) POST JSON tới Apps Script URL (ưu tiên CauHinh/zalo.webhookUrl, nếu rỗng dùng process.env.APPS_SCRIPT_URL)
  //     secret chỉ lấy từ process.env.ZALO_SHARED_SECRET, không đọc từ Firestore
  const appsScriptUrl = resolveWebhookUrl(zaloConfig);
  const sharedSecret = resolveSharedSecret();

  if (!appsScriptUrl) {
    const errMsg = 'Chưa cấu hình URL Web App Apps Script (CauHinh/zalo.webhookUrl hoặc APPS_SCRIPT_URL)';
    await nhatKyRef.update({
      TrangThai: 'Loi',
      MaLoi: 'MISSING_APPS_SCRIPT_URL',
      GhiChu: errMsg,
      TemplateId: templateId,
      TemplateData: templateData,
      ThoiGianGui: serverTimestamp(),
      NgayCapNhatCuoi: serverTimestamp()
    });
    await ensureGoiNhacLichTask(db, hocVien, lop, loaiTin, errMsg);
    return {
      ok: false,
      trangThai: 'Loi',
      docId,
      maLoi: 'MISSING_APPS_SCRIPT_URL',
      ghiChu: errMsg
    };
  }

  const requestPayload = {
    action: 'SEND_ZNS',
    secret: sharedSecret,
    loaiTin,
    templateId,
    trackingId: docId,
    dryRun: effectiveDryRun,
    phone: normalizedPhone,
    templateData
  };

  try {
    const resp = await postToAppsScriptWithRetry(appsScriptUrl, requestPayload, 20000);

    // Kiểm tra phản hồi từ Apps Script
    const isScriptError =
      resp &&
      (resp.ok === false ||
        resp.success === false ||
        (resp.error !== undefined && resp.error !== null && resp.error !== 0 && resp.error !== false));

    if (isScriptError) {
      const maLoi = safeStr(resp.errorCode || resp.maLoi || resp.error || 'ZNS_REJECTED');
      const ghiChu = safeStr(resp.message || resp.ghiChu || 'Apps Script báo lỗi gửi ZNS');

      await nhatKyRef.update({
        TrangThai: 'Loi',
        MaLoi: maLoi,
        GhiChu: ghiChu,
        TemplateId: templateId,
        TemplateData: templateData,
        ThoiGianGui: serverTimestamp(),
        NgayCapNhatCuoi: serverTimestamp()
      });

      // (6) Tạo NhiemVu_ChamSoc khi TrangThai == 'Loi'
      await ensureGoiNhacLichTask(db, hocVien, lop, loaiTin, `${maLoi}: ${ghiChu}`);

      return {
        ok: false,
        trangThai: 'Loi',
        docId,
        maLoi,
        ghiChu
      };
    }

    // (5) Cập nhật TrangThai DaGui / DryRun, ThoiGianGui
    const finalStatus = effectiveDryRun || resp?.dryRun === true ? 'DryRun' : 'DaGui';
    const ghiChuSuccess = safeStr(
      resp?.message ||
        resp?.ghiChu ||
        (finalStatus === 'DryRun' ? 'DryRun qua Apps Script thành công' : 'Đã gửi ZNS thành công')
    );

    await nhatKyRef.update({
      TrangThai: finalStatus,
      DryRun: finalStatus === 'DryRun',
      MaLoi: null,
      GhiChu: ghiChuSuccess,
      TemplateId: templateId,
      TemplateData: templateData,
      ThoiGianGui: serverTimestamp(),
      NgayCapNhatCuoi: serverTimestamp()
    });

    return {
      ok: true,
      trangThai: finalStatus,
      docId,
      templateId,
      ghiChu: ghiChuSuccess
    };
  } catch (err) {
    const maLoi = safeStr(err.code || 'NETWORK_OR_5XX_ERROR');
    const ghiChu = safeStr(err.message || 'Lỗi kết nối Apps Script');

    // (5) Cập nhật TrangThai Loi (MaLoi, GhiChu), ThoiGianGui
    await nhatKyRef.update({
      TrangThai: 'Loi',
      MaLoi: maLoi,
      GhiChu: ghiChu,
      TemplateId: templateId,
      TemplateData: templateData,
      ThoiGianGui: serverTimestamp(),
      NgayCapNhatCuoi: serverTimestamp()
    });

    // (6) Tạo NhiemVu_ChamSoc khi TrangThai == 'Loi'
    await ensureGoiNhacLichTask(db, hocVien, lop, loaiTin, `${maLoi}: ${ghiChu}`);

    return {
      ok: false,
      trangThai: 'Loi',
      docId,
      maLoi,
      ghiChu
    };
  }
}

module.exports = {
  admin,
  VN_TIMEZONE,
  ALLOWED_LOAI_TIN,
  getDb,
  getAuth,
  toDateSafe,
  getVNDateParts,
  diffCalendarDaysVN,
  normalizePhone,
  isValidPhone84,
  buildTemplateData,
  buildNhatKyZaloDocId,
  resolveWebhookUrl,
  resolveSharedSecret,
  resolveTemplateId,
  isLoaiTinEnabled,
  ensureGoiNhacLichTask,
  postToAppsScriptWithRetry,
  guiTin
};
