'use strict';

/**
 * Lõi xử lý quét hằng ngày nhắc lịch khai giảng (NhacT3, NhacT1) dùng chung cho:
 * - netlify/functions/zalo-daily.js (Scheduled Function chạy 08:00 sáng giờ VN - chỉ lần chạy thật mới ghi NhatKy_Zalo)
 * - netlify/functions/zalo-run-now.js (Nút "Quét ngay (dry-run)" trên giao diện - KHÔNG ghi vào NhatKy_Zalo)
 * Không sử dụng onSnapshot.
 */

const {
  getDb,
  getVNDateParts,
  diffCalendarDaysVN,
  normalizePhone,
  isValidPhone84,
  buildNhatKyZaloDocId,
  resolveTemplateId,
  isLoaiTinEnabled,
  guiTin
} = require('./_zalo-lib');

// Giới hạn tối đa 40 tin mỗi lần chạy để đảm bảo không vượt quá giới hạn thời gian chạy
// (execution timeout ~10–30 giây) của Netlify Scheduled Function.
const MAX_MESSAGES_PER_RUN = 40;

function createEmptyByLoaiTin() {
  return {
    XepLop: { tong: 0, seGui: 0, boQua: 0, daGui: 0, loi: 0 },
    NhacT3: { tong: 0, seGui: 0, boQua: 0, daGui: 0, loi: 0 },
    NhacT1: { tong: 0, seGui: 0, boQua: 0, daGui: 0, loi: 0 }
  };
}

async function runDailyZaloScan(options = {}) {
  const db = getDb();
  const now = new Date();
  const todayVN = getVNDateParts(now);

  const forceDryRun = typeof options.dryRun === 'boolean' ? options.dryRun : undefined;
  const skipAppsScriptOnDryRun = Boolean(options.skipAppsScriptOnDryRun);
  // Chế độ "Quét ngay (dry-run)" từ giao diện: KHÔNG ghi vào NhatKy_Zalo
  const previewOnly = Boolean(options.previewOnly);

  const byLoaiTin = createEmptyByLoaiTin();
  const items = [];

  const summary = {
    dateVN: todayVN ? todayVN.ymdDash : '',
    previewOnly,
    forceDryRun: Boolean(forceDryRun),
    skipAppsScriptOnDryRun,
    maxMessagesPerRun: MAX_MESSAGES_PER_RUN,
    scannedClasses: 0,
    scannedRegistrations: 0,
    processedCount: 0,
    conLai: 0,
    daGui: 0,
    dryRun: 0,
    loi: 0,
    boQua: 0,
    alreadySent: 0,
    byLoaiTin,
    items
  };

  // Đọc cấu hình CauHinh/zalo để xác định chế độ chạy thật hay chạy thử (dryRun)
  const zaloCfgSnap = await db.collection('CauHinh').doc('zalo').get();
  const zaloConfig = zaloCfgSnap && zaloCfgSnap.exists ? zaloCfgSnap.data() || {} : {};
  const isMasterEnabled = Boolean(zaloCfgSnap && zaloCfgSnap.exists && zaloConfig.enabled === true);
  const envDefaultDryRun = ['1', 'true', 'yes'].includes(
    String(process.env.ZALO_DEFAULT_DRY_RUN || '')
      .trim()
      .toLowerCase()
  );
  const effectiveDryRun =
    typeof forceDryRun === 'boolean'
      ? forceDryRun
      : typeof zaloConfig.dryRun === 'boolean'
      ? zaloConfig.dryRun
      : envDefaultDryRun;
  const isDryRun = Boolean(previewOnly || effectiveDryRun);
  const acceptedSentStatuses = isDryRun ? ['DaGui', 'DryRun'] : ['DaGui'];

  summary.effectiveDryRun = isDryRun;

  // 1. Quét tất cả LopKhaiGiang có TrangThai == 'SapKhaiGiang' (không dùng onSnapshot)
  const lopSnap = await db
    .collection('LopKhaiGiang')
    .where('TrangThai', '==', 'SapKhaiGiang')
    .get();

  summary.scannedClasses = lopSnap.size;

  for (const lopDoc of lopSnap.docs) {
    const lop = { id: lopDoc.id, ...lopDoc.data() };
    if (lop.LaDuLieuMau === true) continue;
    const daysLeft = diffCalendarDaysVN(lop.NgayKhaiGiangDuKien, now);

    // Chỉ các lớp có daysLeft thuộc [0, 1, 2, 3] mới thuộc diện gửi NhacT3 hoặc NhacT1
    if (daysLeft === null || daysLeft < 0 || daysLeft > 3) {
      continue;
    }

    const lopKgParts = getVNDateParts(lop.NgayKhaiGiangDuKien);

    // 2. Lấy các PhieuDangKy_Hoc có TrangThaiPhieu == 'DangHieuLuc' của lớp đó
    const phieuSnap = await db
      .collection('PhieuDangKy_Hoc')
      .where('ID_Lop', '==', lop.id)
      .where('TrangThaiPhieu', '==', 'DangHieuLuc')
      .get();

    for (const phieuDoc of phieuSnap.docs) {
      const phieu = { id: phieuDoc.id, ...phieuDoc.data() };
      if (phieu.LaDuLieuMau === true) continue;
      summary.scannedRegistrations++;
      const hocVienId = phieu.ID_HocVien;
      if (!hocVienId) continue;

      let targetLoaiTin = null;

      // Điều kiện chọn học viên nhận NhacT3 / NhacT1:
      // - NhacT3: 1 < daysLeft <= 3 (tức daysLeft === 2 hoặc daysLeft === 3)
      //   VÀ tin XepLop của phiếu đó đã gửi ở ngày TRƯỚC hôm nay theo giờ VN (xếp lớp muộn trong ngày thì bỏ qua T-3).
      //   Khi chạy thật (!isDryRun): chỉ chấp nhận XepLop có TrangThai === 'DaGui'.
      //   Khi chạy thử (isDryRun): chấp nhận cả 'DaGui' và 'DryRun'.
      if (daysLeft > 1 && daysLeft <= 3) {
        const xepLopDocId = buildNhatKyZaloDocId(
          hocVienId,
          lop.id,
          'XepLop',
          lop.NgayKhaiGiangDuKien
        );
        const xepLopSnap = await db.collection('NhatKy_Zalo').doc(xepLopDocId).get();

        if (xepLopSnap.exists) {
          const xepLopData = xepLopSnap.data() || {};
          const xepLopSentStatus = xepLopData.TrangThai;
          const sentTimeParts = getVNDateParts(xepLopData.ThoiGianGui || xepLopData.NgayTao);

          if (
            acceptedSentStatuses.includes(xepLopSentStatus) &&
            sentTimeParts &&
            todayVN &&
            sentTimeParts.ymdCompact < todayVN.ymdCompact
          ) {
            targetLoaiTin = 'NhacT3';
          }
        }
      }
      // - NhacT1: daysLeft == 1 (hoặc daysLeft == 0 mà chưa gửi NhacT1;
      //   khi chạy thật chỉ coi 'DaGui' là đã gửi, khi chạy thử coi cả 'DaGui' và 'DryRun' là đã gửi)
      else if (daysLeft === 1) {
        targetLoaiTin = 'NhacT1';
      } else if (daysLeft === 0) {
        const nhacT1DocId = buildNhatKyZaloDocId(
          hocVienId,
          lop.id,
          'NhacT1',
          lop.NgayKhaiGiangDuKien
        );
        const nhacT1Snap = await db.collection('NhatKy_Zalo').doc(nhacT1DocId).get();
        const nhacT1Status = nhacT1Snap.exists ? nhacT1Snap.data()?.TrangThai : null;
        const alreadySentT1 =
          nhacT1Status === 'DaGui' || (isDryRun && nhacT1Status === 'DryRun');

        if (!alreadySentT1) {
          targetLoaiTin = 'NhacT1';
        }
      }

      if (!targetLoaiTin) continue;

      // Chế độ "Quét ngay (dry-run)" từ giao diện: KHÔNG ghi vào NhatKy_Zalo,
      // chỉ trả về danh sách {hocVien, lop, loaiTin, lyDoBoQua?} và tổng hợp theo từng loaiTin
      if (previewOnly) {
        const targetDocId = buildNhatKyZaloDocId(
          hocVienId,
          lop.id,
          targetLoaiTin,
          lop.NgayKhaiGiangDuKien
        );
        const [hvSnap, targetNkSnap] = await Promise.all([
          db.collection('HocVien').doc(hocVienId).get(),
          db.collection('NhatKy_Zalo').doc(targetDocId).get()
        ]);

        const hvData = hvSnap.exists ? { id: hvSnap.id, ...hvSnap.data() } : null;
        const existingNk = targetNkSnap.exists ? targetNkSnap.data() || {} : null;
        const phone84 = normalizePhone(hvData?.SoDienThoai || phieu.SoDienThoai || '');

        let lyDoBoQua = null;
        if (existingNk && existingNk.TrangThai === 'DaGui') {
          lyDoBoQua = 'Đã gửi trước đó (DaGui)';
        } else if (isDryRun && existingNk && existingNk.TrangThai === 'DryRun') {
          lyDoBoQua = 'Đã chạy thử trước đó (DryRun)';
        } else if (!isMasterEnabled) {
          lyDoBoQua = 'Tắt tự động';
        } else if (!isLoaiTinEnabled(targetLoaiTin, zaloConfig)) {
          lyDoBoQua = 'Loại tin đang tắt';
        } else if (!hvData) {
          lyDoBoQua = 'Không tìm thấy hồ sơ học viên';
        } else if (['Huy', 'MatKetNoi'].includes(hvData.TrangThai)) {
          lyDoBoQua = `Học viên ở trạng thái ${hvData.TrangThai}`;
        } else if (!isValidPhone84(phone84)) {
          lyDoBoQua = `Số điện thoại sai định dạng (${hvData.SoDienThoai || 'trống'})`;
        } else if (!resolveTemplateId(targetLoaiTin, zaloConfig)) {
          lyDoBoQua = `Thiếu mã template ZNS (${targetLoaiTin})`;
        }

        if (summary.processedCount >= MAX_MESSAGES_PER_RUN) {
          summary.conLai++;
          if (!lyDoBoQua) {
            lyDoBoQua = `Vượt trần ${MAX_MESSAGES_PER_RUN} tin/lần chạy (chờ lần sau)`;
          }
        } else {
          summary.processedCount++;
        }

        const bucket = byLoaiTin[targetLoaiTin] || { tong: 0, seGui: 0, boQua: 0, daGui: 0, loi: 0 };
        bucket.tong++;
        if (lyDoBoQua) {
          bucket.boQua++;
          summary.boQua++;
        } else {
          bucket.seGui++;
          summary.dryRun++;
        }
        byLoaiTin[targetLoaiTin] = bucket;

        const rowItem = {
          hocVien: {
            id: hocVienId,
            HoTen: hvData?.HoTen || phieu.TenHocVien || '',
            SoDienThoai: hvData?.SoDienThoai || phieu.SoDienThoai || '',
            TrangThai: hvData?.TrangThai || ''
          },
          lop: {
            id: lop.id,
            MaLop: lop.MaLop || '',
            TenLop: lop.TenLop || '',
            NgayKhaiGiang: lopKgParts ? lopKgParts.ymdDash : '',
            soNgayConLai: daysLeft
          },
          loaiTin: targetLoaiTin
        };
        if (lyDoBoQua) {
          rowItem.lyDoBoQua = lyDoBoQua;
        }
        items.push(rowItem);
        continue;
      }

      // Lần chạy thật (hoặc cron zalo-daily): nếu chạm trần MAX_MESSAGES_PER_RUN (40) thì tăng conLai, không gọi guiTin
      if (summary.processedCount >= MAX_MESSAGES_PER_RUN) {
        summary.conLai++;
        continue;
      }

      summary.processedCount++;

      const guiOptions = {};
      if (typeof forceDryRun === 'boolean') {
        guiOptions.dryRun = forceDryRun;
      }
      if (skipAppsScriptOnDryRun) {
        guiOptions.skipAppsScriptOnDryRun = true;
      }

      const res = await guiTin(targetLoaiTin, hocVienId, lop.id, guiOptions);
      const bucket = byLoaiTin[targetLoaiTin] || { tong: 0, seGui: 0, boQua: 0, daGui: 0, loi: 0 };
      bucket.tong++;

      if (res.alreadySent) {
        summary.alreadySent++;
        bucket.boQua++;
      } else if (res.trangThai === 'DaGui') {
        summary.daGui++;
        bucket.daGui++;
      } else if (res.trangThai === 'DryRun') {
        summary.dryRun++;
        bucket.seGui++;
      } else if (res.trangThai === 'Loi') {
        summary.loi++;
        bucket.loi++;
      } else {
        summary.boQua++;
        bucket.boQua++;
      }
      byLoaiTin[targetLoaiTin] = bucket;
    }
  }

  return summary;
}

module.exports = {
  MAX_MESSAGES_PER_RUN,
  runDailyZaloScan
};
