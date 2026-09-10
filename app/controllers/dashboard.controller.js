const Invoice = require("../models/invoice.model");
const Reservation = require("../models/reservation.model");
const Table = require("../models/table.model");
const Ingredient = require("../models/ingredient.model");
const Order = require("../models/order.model");
const ExcelJS = require("exceljs");
const AppError = require("../app-error");

// Helper chuẩn hóa khoảng thời gian tìm kiếm từ YYYY-MM-DD
const parseDateRange = (startDateStr, endDateStr) => {
  let start, end;
  if (startDateStr) {
    start = new Date(startDateStr);
    if (startDateStr.length <= 10) {
      start.setHours(0, 0, 0, 0);
    }
  } else {
    start = new Date();
    start.setHours(0, 0, 0, 0);
  }

  if (endDateStr) {
    end = new Date(endDateStr);
    if (endDateStr.length <= 10) {
      end.setHours(23, 59, 59, 999);
    }
  } else {
    end = new Date();
    end.setHours(23, 59, 59, 999);
  }
  return { start, end };
};

// Báo cáo tổng quan kinh doanh cho Dashboard
exports.getDashboardStats = async (req, res, next) => {
  try {
    const { startDate, endDate } = req.query;
    const { start, end } = parseDateRange(startDate, endDate);

    // 1. Thống kê Doanh thu từ Hóa đơn đã thanh toán
    const invoices = await Invoice.find({
      paidAt: { $gte: start, $lte: end },
      paymentStatus: "PAID",
    });

    const totalRevenue = invoices.reduce((sum, inv) => sum + (inv.finalAmount || 0), 0);
    const invoiceCount = invoices.length;

    // 2. Thống kê Đặt bàn (Reservation)
    const reservationsCount = await Reservation.countDocuments({
      createdAt: { $gte: start, $lte: end },
    });

    // 3. Thống kê Tỷ lệ lấp đầy bàn hiện tại
    const totalTables = await Table.countDocuments({ isActive: true });
    const occupiedTables = await Table.countDocuments({ isActive: true, status: "OCCUPIED" });
    const occupancyRate = totalTables > 0 ? ((occupiedTables / totalTables) * 100).toFixed(1) : 0;

    // 4. Top 5 món ăn bán chạy nhất
    const topDishesPipeline = [
      { $unwind: "$items" },
      {
        $group: {
          _id: "$items.dish",
          totalQuantity: { $sum: "$items.quantity" },
          totalRevenue: { $sum: { $multiply: ["$items.quantity", "$items.price"] } },
        },
      },
      { $sort: { totalQuantity: -1 } },
      { $limit: 5 },
      {
        $lookup: {
          from: "dishes",
          localField: "_id",
          foreignField: "_id",
          as: "dishInfo",
        },
      },
      { $unwind: "$dishInfo" },
      {
        $project: {
          _id: 1,
          name: "$dishInfo.name",
          image: "$dishInfo.image",
          price: "$dishInfo.price",
          totalQuantity: 1,
          totalRevenue: 1,
        },
      },
    ];

    const topDishes = await Order.aggregate(topDishesPipeline);

    // 5. Thống kê cảnh báo tồn kho (Nguyên liệu chạm ngưỡng)
    const allIngredients = await Ingredient.find();
    const lowStockIngredients = allIngredients.filter((ing) => ing.stockQuantity <= ing.minStockLevel);

    // 6. Doanh thu theo từng ngày (biểu đồ)
    const revenueByDay = await Invoice.aggregate([
      { $match: { paidAt: { $gte: start, $lte: end }, paymentStatus: "PAID" } },
      {
        $group: {
          _id: { $dateToString: { format: "%Y-%m-%d", date: "$paidAt" } },
          total: { $sum: "$finalAmount" },
        },
      },
      { $sort: { _id: 1 } },
    ]);

    // 7. Phân bổ theo phương thức thanh toán
    const paymentMethodBreakdown = await Invoice.aggregate([
      { $match: { paidAt: { $gte: start, $lte: end }, paymentStatus: "PAID" } },
      { $group: { _id: "$paymentMethod", total: { $sum: "$finalAmount" }, count: { $sum: 1 } } },
    ]);

    // 8. Thống kê đơn đặt bàn theo trạng thái (PENDING / CONFIRMED / ARRIVED / COMPLETED / CANCELLED)
    const reservationStatusCounts = await Reservation.aggregate([
      { $match: { createdAt: { $gte: start, $lte: end } } },
      { $group: { _id: "$status", count: { $sum: 1 } } },
    ]);

    // 9. Thống kê đơn gọi món theo trạng thái (PENDING / PREPARING / SERVED / CANCELLED)
    const orderStatusCounts = await Order.aggregate([
      { $match: { createdAt: { $gte: start, $lte: end } } },
      { $group: { _id: "$status", count: { $sum: 1 } } },
    ]);

    // 10. Thống kê tiền cọc (đã thu / chờ thu)
    const reservationsInRange = await Reservation.find({ createdAt: { $gte: start, $lte: end } });
    const depositCollected = reservationsInRange
      .filter((r) => r.depositStatus === "PAID")
      .reduce((s, r) => s + (r.depositAmount || 0), 0);
    const depositPending = reservationsInRange
      .filter((r) => r.depositStatus !== "PAID")
      .reduce((s, r) => s + (r.depositAmount || 0), 0);

    // 11. Thống kê biểu đồ Giờ Cao Điểm (Peak Hours: 08:00 -> 23:00)
    const peakHoursRaw = await Invoice.aggregate([
      { $match: { paidAt: { $gte: start, $lte: end }, paymentStatus: "PAID" } },
      {
        $group: {
          _id: { $hour: { date: "$paidAt", timezone: "+07:00" } },
          totalRevenue: { $sum: "$finalAmount" },
          orderCount: { $sum: 1 },
        },
      },
      { $sort: { _id: 1 } },
    ]);

    const peakHoursMap = new Map();
    peakHoursRaw.forEach((item) => {
      peakHoursMap.set(item._id, item);
    });

    const peakHours = [];
    for (let h = 8; h <= 23; h++) {
      const match = peakHoursMap.get(h);
      peakHours.push({
        hour: h,
        label: `${String(h).padStart(2, "0")}:00`,
        orderCount: match ? match.orderCount : 0,
        revenue: match ? match.totalRevenue : 0,
      });
    }

    res.status(200).json({
      status: "success",
      filterRange: { start, end },
      data: {
        totalRevenue,
        invoiceCount,
        reservationsCount,
        tablesOverview: {
          totalTables,
          occupiedTables,
          occupancyRate: `${occupancyRate}%`,
        },
        topDishes,
        revenueByDay,
        paymentMethodBreakdown,
        reservationStatusCounts,
        orderStatusCounts,
        peakHours,
        depositStats: {
          collected: depositCollected,
          pending: depositPending,
        },
        lowStockAlerts: {
          count: lowStockIngredients.length,
          ingredients: lowStockIngredients,
        },
      },
    });
  } catch (error) {
    next(error);
  }
};

// Xuất báo cáo tổng hợp doanh thu & kết quả kinh doanh ra file Excel (.xlsx) chuẩn công thức & số liệu
exports.exportInvoicesCsv = async (req, res, next) => {
  try {
    const { startDate, endDate } = req.query;
    const { start, end } = parseDateRange(startDate, endDate);

    // 1. Lấy dữ liệu hóa đơn chi tiết trong kỳ
    const invoices = await Invoice.find({
      paidAt: { $gte: start, $lte: end },
      paymentStatus: "PAID",
    })
      .populate({
        path: "diningSession",
        populate: { path: "tables", select: "tableNumber" },
      })
      .populate("cashier", "name email")
      .sort({ paidAt: -1 });

    const totalRevenue = invoices.reduce((sum, inv) => sum + (inv.finalAmount || 0), 0);
    const invoiceCount = invoices.length;
    const totalDiscount = invoices.reduce((sum, inv) => sum + (inv.discountAmount || 0), 0);
    const totalTax = invoices.reduce((sum, inv) => sum + (inv.taxAmount || 0), 0);
    const totalSubtotal = invoices.reduce((sum, inv) => sum + (inv.subtotal || 0), 0);
    const totalDepositDeducted = invoices.reduce((sum, inv) => sum + (inv.depositDeducted || 0), 0);
    const avgOrderValue = invoiceCount > 0 ? Math.round(totalRevenue / invoiceCount) : 0;

    const reservationsCount = await Reservation.countDocuments({
      createdAt: { $gte: start, $lte: end },
    });

    const totalTables = await Table.countDocuments({ isActive: true });
    const occupiedTables = await Table.countDocuments({ isActive: true, status: "OCCUPIED" });
    const occupancyRate = totalTables > 0 ? ((occupiedTables / totalTables) * 100).toFixed(1) : "0.0";

    // 2. Phương thức thanh toán
    const paymentBreakdownMap = new Map();
    invoices.forEach((inv) => {
      const method = inv.paymentMethod || "CASH";
      const current = paymentBreakdownMap.get(method) || { count: 0, amount: 0 };
      current.count += 1;
      current.amount += inv.finalAmount || 0;
      paymentBreakdownMap.set(method, current);
    });

    const methodLabels = {
      CASH: "Tiền mặt tại quầy",
      BANK_TRANSFER: "Chuyển khoản VietQR",
      VNPAY: "Cổng VNPAY",
      MOMO: "Ví điện tử MoMo",
      CARD: "Thẻ POS / Ngân hàng",
    };

    // 3. Top món ăn
    const topDishes = await Order.aggregate([
      { $match: { createdAt: { $gte: start, $lte: end } } },
      { $unwind: "$items" },
      {
        $group: {
          _id: "$items.dish",
          totalQuantity: { $sum: "$items.quantity" },
          totalRevenue: { $sum: { $multiply: ["$items.quantity", "$items.price"] } },
        },
      },
      { $sort: { totalQuantity: -1 } },
      { $limit: 30 },
      {
        $lookup: {
          from: "dishes",
          localField: "_id",
          foreignField: "_id",
          as: "dishInfo",
        },
      },
      { $unwind: "$dishInfo" },
      {
        $project: {
          _id: 1,
          name: "$dishInfo.name",
          price: "$dishInfo.price",
          category: "$dishInfo.category",
          totalQuantity: 1,
          totalRevenue: 1,
        },
      },
    ]);

    // 4. Giờ cao điểm
    const peakHoursRaw = await Invoice.aggregate([
      { $match: { paidAt: { $gte: start, $lte: end }, paymentStatus: "PAID" } },
      {
        $group: {
          _id: { $hour: { date: "$paidAt", timezone: "+07:00" } },
          totalRevenue: { $sum: "$finalAmount" },
          orderCount: { $sum: 1 },
        },
      },
      { $sort: { _id: 1 } },
    ]);
    const peakMap = new Map(peakHoursRaw.map((p) => [p._id, p]));

    // ==========================================
    // TẠO WORKBOOK EXCEL NATIVE BẰNG EXCELJS
    // ==========================================
    const workbook = new ExcelJS.Workbook();
    workbook.creator = "Hệ Thống Nhà Hàng 3 Miền Cua";
    workbook.created = new Date();

    const headerFill = {
      type: "pattern",
      pattern: "solid",
      fgColor: { argb: "FFC0392B" }, // Red
    };
    const titleFill = {
      type: "pattern",
      pattern: "solid",
      fgColor: { argb: "FF8B0000" }, // Dark Red
    };
    const subHeaderFill = {
      type: "pattern",
      pattern: "solid",
      fgColor: { argb: "FF2C3E50" }, // Dark Slate
    };
    const totalRowFill = {
      type: "pattern",
      pattern: "solid",
      fgColor: { argb: "FFF8F9FA" },
    };
    const headerFont = { name: "Arial", size: 10, bold: true, color: { argb: "FFFFFFFF" } };
    const thinBorder = {
      top: { style: "thin", color: { argb: "FFD3D3D3" } },
      left: { style: "thin", color: { argb: "FFD3D3D3" } },
      bottom: { style: "thin", color: { argb: "FFD3D3D3" } },
      right: { style: "thin", color: { argb: "FFD3D3D3" } },
    };
    const doubleBottomBorder = {
      top: { style: "thin", color: { argb: "FF000000" } },
      left: { style: "thin", color: { argb: "FFD3D3D3" } },
      bottom: { style: "double", color: { argb: "FF000000" } },
      right: { style: "thin", color: { argb: "FFD3D3D3" } },
    };

    // ───────────────────────────────────────────
    // SHEET 1: DANH SÁCH HÓA ĐƠN CHI TIẾT
    // ───────────────────────────────────────────
    const wsInvoices = workbook.addWorksheet("1. Chi Tiết Hóa Đơn", {
      views: [{ showGridLines: true }],
    });

    // Title Block
    wsInvoices.mergeCells("A1:O1");
    const t1 = wsInvoices.getCell("A1");
    t1.value = "BÁO CÁO CHI TIẾT DOANH THU & HÓA ĐƠN BÁN HÀNG";
    t1.font = { name: "Arial", size: 14, bold: true, color: { argb: "FFFFFFFF" } };
    t1.fill = titleFill;
    t1.alignment = { vertical: "middle", horizontal: "center" };
    wsInvoices.getRow(1).height = 30;

    wsInvoices.mergeCells("A2:O2");
    const t2 = wsInvoices.getCell("A2");
    t2.value = `Nhà Hàng 3 Miền Cua · Thời gian: ${start.toLocaleDateString("vi-VN")} - ${end.toLocaleDateString("vi-VN")} · Xuất lúc: ${new Date().toLocaleString("vi-VN")}`;
    t2.font = { name: "Arial", size: 9, italic: true, color: { argb: "FF555555" } };
    t2.alignment = { vertical: "middle", horizontal: "center" };
    wsInvoices.getRow(2).height = 20;

    // Columns config
    wsInvoices.columns = [
      { key: "stt", width: 6 },
      { key: "code", width: 16 },
      { key: "session", width: 14 },
      { key: "customer", width: 22 },
      { key: "phone", width: 14 },
      { key: "tables", width: 14 },
      { key: "checkIn", width: 18 },
      { key: "paidAt", width: 18 },
      { key: "subtotal", width: 16 },
      { key: "discount", width: 14 },
      { key: "tax", width: 14 },
      { key: "deposit", width: 14 },
      { key: "final", width: 18 },
      { key: "method", width: 20 },
      { key: "cashier", width: 16 },
    ];

    // Table Headers (Row 4)
    const invHeaderRow = wsInvoices.getRow(4);
    invHeaderRow.values = [
      "STT",
      "Mã Hóa Đơn",
      "Mã Phiên",
      "Khách Hàng",
      "Số Điện Thoại",
      "Bàn Ăn",
      "Giờ Vào",
      "Giờ Thanh Toán",
      "Tiền Món (VNĐ)",
      "Giảm Giá (VNĐ)",
      "Thuế VAT (VNĐ)",
      "Trừ Cọc (VNĐ)",
      "Thực Thu (VNĐ)",
      "Hình Thức TT",
      "Thu Ngân",
    ];
    invHeaderRow.height = 26;
    invHeaderRow.eachCell((cell) => {
      cell.fill = headerFill;
      cell.font = headerFont;
      cell.alignment = { vertical: "middle", horizontal: "center" };
      cell.border = thinBorder;
    });

    // Populate Invoices Data Rows
    let rowIdx = 5;
    invoices.forEach((inv, i) => {
      const row = wsInvoices.getRow(rowIdx);
      const tableNumbers = (inv.diningSession?.tables || []).map((t) => t.tableNumber).join(", ") || "Chưa gán";
      const customer = inv.diningSession?.customerName || "Khách lẻ";
      const phone = inv.diningSession?.customerPhone || "";
      const sessionCode = inv.diningSession?.sessionCode || "";
      const checkInTime = inv.diningSession?.checkInTime ? new Date(inv.diningSession.checkInTime).toLocaleString("vi-VN") : "";
      const paidTime = inv.paidAt ? new Date(inv.paidAt).toLocaleString("vi-VN") : "";
      const method = methodLabels[inv.paymentMethod] || inv.paymentMethod || "Tiền mặt";
      const cashierName = inv.cashier?.name || "Thu ngân";

      row.values = [
        i + 1,
        inv.invoiceCode || `INV-${inv._id.toString().slice(-6).toUpperCase()}`,
        sessionCode,
        customer,
        phone,
        tableNumbers,
        checkInTime,
        paidTime,
        Number(inv.subtotal || 0),
        Number(inv.discountAmount || 0),
        Number(inv.taxAmount || 0),
        Number(inv.depositDeducted || 0),
        Number(inv.finalAmount || 0),
        method,
        cashierName,
      ];

      // Cell formatting & alignment
      row.getCell(1).alignment = { horizontal: "center" };
      row.getCell(2).alignment = { horizontal: "center" };
      row.getCell(3).alignment = { horizontal: "center" };
      row.getCell(5).alignment = { horizontal: "center" };
      row.getCell(6).alignment = { horizontal: "center" };
      row.getCell(7).alignment = { horizontal: "center" };
      row.getCell(8).alignment = { horizontal: "center" };
      row.getCell(14).alignment = { horizontal: "center" };

      // Number formatting for numeric columns
      [9, 10, 11, 12, 13].forEach((colNum) => {
        const c = row.getCell(colNum);
        c.numFmt = "#,##0";
        c.alignment = { horizontal: "right" };
      });

      row.eachCell((c) => {
        c.border = thinBorder;
        c.font = { name: "Arial", size: 9.5 };
      });

      rowIdx++;
    });

    // Summary Formula Row at the bottom
    const totalRow = wsInvoices.getRow(rowIdx);
    wsInvoices.mergeCells(`A${rowIdx}:H${rowIdx}`);
    const summaryLabel = wsInvoices.getCell(`A${rowIdx}`);
    summaryLabel.value = "TỔNG CỘNG";
    summaryLabel.font = { name: "Arial", size: 10, bold: true, color: { argb: "FFC0392B" } };
    summaryLabel.alignment = { vertical: "middle", horizontal: "right" };

    if (invoices.length > 0) {
      totalRow.getCell(9).value = { formula: `SUM(I5:I${rowIdx - 1})` };
      totalRow.getCell(10).value = { formula: `SUM(J5:J${rowIdx - 1})` };
      totalRow.getCell(11).value = { formula: `SUM(K5:K${rowIdx - 1})` };
      totalRow.getCell(12).value = { formula: `SUM(L5:L${rowIdx - 1})` };
      totalRow.getCell(13).value = { formula: `SUM(M5:M${rowIdx - 1})` };
    } else {
      totalRow.getCell(9).value = 0;
      totalRow.getCell(10).value = 0;
      totalRow.getCell(11).value = 0;
      totalRow.getCell(12).value = 0;
      totalRow.getCell(13).value = 0;
    }

    [9, 10, 11, 12, 13].forEach((colNum) => {
      const c = totalRow.getCell(colNum);
      c.numFmt = "#,##0";
      c.font = { name: "Arial", size: 10, bold: true, color: { argb: "FFC0392B" } };
      c.alignment = { horizontal: "right" };
    });

    totalRow.height = 24;
    totalRow.eachCell((c) => {
      c.fill = totalRowFill;
      c.border = doubleBottomBorder;
    });

    // ───────────────────────────────────────────
    // SHEET 2: BÁO CÁO TỔNG HỢP KPI
    // ───────────────────────────────────────────
    const wsKpi = workbook.addWorksheet("2. Tổng Hợp KPI", {
      views: [{ showGridLines: true }],
    });
    wsKpi.columns = [
      { key: "kpi", width: 36 },
      { key: "value", width: 22 },
      { key: "unit", width: 14 },
      { key: "note", width: 34 },
    ];

    wsKpi.mergeCells("A1:D1");
    const kpiT1 = wsKpi.getCell("A1");
    kpiT1.value = "BẢNG TỔNG HỢP CHỈ SỐ KINH DOANH CHÍNH (EXECUTIVE KPI)";
    kpiT1.font = { name: "Arial", size: 13, bold: true, color: { argb: "FFFFFFFF" } };
    kpiT1.fill = titleFill;
    kpiT1.alignment = { vertical: "middle", horizontal: "center" };
    wsKpi.getRow(1).height = 28;

    const kpiHeader = wsKpi.getRow(3);
    kpiHeader.values = ["Chỉ Số Kinh Doanh", "Giá Trị", "Đơn Vị", "Ghi Chú"];
    kpiHeader.height = 24;
    kpiHeader.eachCell((c) => {
      c.fill = subHeaderFill;
      c.font = headerFont;
      c.alignment = { vertical: "middle", horizontal: "center" };
      c.border = thinBorder;
    });

    const kpiData = [
      {
        kpi: "Tổng Doanh Thu Thực Tế",
        val: invoices.length > 0 ? { formula: `'1. Chi Tiết Hóa Đơn'!M${rowIdx}` } : totalRevenue,
        unit: "VNĐ",
        note: "Tổng số tiền thực tế thu từ khách",
        isMoney: true,
        bold: true,
      },
      {
        kpi: "Tổng Số Hóa Đơn Đã Thu",
        val: invoiceCount,
        unit: "Hóa đơn",
        note: "Lượt bàn đã hoàn tất thanh toán",
        isMoney: false,
        bold: false,
      },
      {
        kpi: "Doanh Thu Trung Bình / Hóa Đơn (AOV)",
        val: invoices.length > 0 ? { formula: `IF(B5>0, ROUND(B4/B5, 0), 0)` } : avgOrderValue,
        unit: "VNĐ/HĐ",
        note: "Giá trị trung bình mỗi lượt bàn",
        isMoney: true,
        bold: false,
      },
      {
        kpi: "Tổng Tiền Món Trước Giảm Giá",
        val: invoices.length > 0 ? { formula: `'1. Chi Tiết Hóa Đơn'!I${rowIdx}` } : totalSubtotal,
        unit: "VNĐ",
        note: "Tổng nguyên giá thực đơn",
        isMoney: true,
        bold: false,
      },
      {
        kpi: "Tổng Tiền Giảm Giá / Voucher",
        val: invoices.length > 0 ? { formula: `'1. Chi Tiết Hóa Đơn'!J${rowIdx}` } : totalDiscount,
        unit: "VNĐ",
        note: "Ưu đãi và chiết khấu cho khách",
        isMoney: true,
        bold: false,
      },
      {
        kpi: "Tổng Tiền Thuế VAT Đã Tính",
        val: invoices.length > 0 ? { formula: `'1. Chi Tiết Hóa Đơn'!K${rowIdx}` } : totalTax,
        unit: "VNĐ",
        note: "Thuế giá trị gia tăng",
        isMoney: true,
        bold: false,
      },
      {
        kpi: "Tổng Tiền Cọc Đã Khấu Trừ",
        val: invoices.length > 0 ? { formula: `'1. Chi Tiết Hóa Đơn'!L${rowIdx}` } : totalDepositDeducted,
        unit: "VNĐ",
        note: "Tiền cọc trừ trực tiếp vào hóa đơn",
        isMoney: true,
        bold: false,
      },
      {
        kpi: "Tổng Số Lượt Đặt Bàn Trong Kỳ",
        val: reservationsCount,
        unit: "Lượt đặt",
        note: "Đơn đặt bàn qua Website & Hotline",
        isMoney: false,
        bold: false,
      },
      {
        kpi: "Tỷ Lệ Lấp Đầy Bàn Hiện Tại",
        val: Number(occupancyRate) / 100,
        unit: "%",
        note: "Mật độ sử dụng bàn nhà hàng",
        isPercent: true,
        bold: false,
      },
    ];

    kpiData.forEach((item, idx) => {
      const r = wsKpi.getRow(idx + 4);
      r.values = [item.kpi, item.val, item.unit, item.note];
      r.height = 22;

      r.getCell(1).font = { name: "Arial", size: 10, bold: item.bold };
      r.getCell(3).alignment = { horizontal: "center" };

      const valCell = r.getCell(2);
      if (item.isPercent) {
        valCell.numFmt = "0.0%";
      } else if (item.isMoney) {
        valCell.numFmt = "#,##0";
      } else {
        valCell.numFmt = "#,##0";
      }
      valCell.font = { name: "Arial", size: 10, bold: item.bold, color: item.bold ? { argb: "FFC0392B" } : undefined };
      valCell.alignment = { horizontal: "right" };

      r.eachCell((c) => {
        c.border = thinBorder;
      });
    });

    // ───────────────────────────────────────────
    // SHEET 3: TOP MÓN ĂN BÁN CHẠY
    // ───────────────────────────────────────────
    const wsDishes = workbook.addWorksheet("3. Top Món Bán Chạy", {
      views: [{ showGridLines: true }],
    });
    wsDishes.columns = [
      { key: "stt", width: 6 },
      { key: "name", width: 32 },
      { key: "price", width: 18 },
      { key: "qty", width: 16 },
      { key: "total", width: 22 },
    ];

    wsDishes.mergeCells("A1:E1");
    const dishT = wsDishes.getCell("A1");
    dishT.value = "BÁO CÁO TOP MÓN ĂN BÁN CHẠY & DOANH SỐ TỪNG MÓN";
    dishT.font = { name: "Arial", size: 13, bold: true, color: { argb: "FFFFFFFF" } };
    dishT.fill = titleFill;
    dishT.alignment = { vertical: "middle", horizontal: "center" };
    wsDishes.getRow(1).height = 28;

    const dishHeader = wsDishes.getRow(3);
    dishHeader.values = ["STT", "Tên Món Ăn", "Đơn Giá (VNĐ)", "Số Lượng Bán", "Tổng Doanh Thu (VNĐ)"];
    dishHeader.height = 24;
    dishHeader.eachCell((c) => {
      c.fill = subHeaderFill;
      c.font = headerFont;
      c.alignment = { vertical: "middle", horizontal: "center" };
      c.border = thinBorder;
    });

    let dRowIdx = 4;
    topDishes.forEach((d, idx) => {
      const r = wsDishes.getRow(dRowIdx);
      r.values = [
        idx + 1,
        d.name,
        Number(d.price || 0),
        Number(d.totalQuantity || 0),
        { formula: `C${dRowIdx}*D${dRowIdx}` },
      ];
      r.getCell(1).alignment = { horizontal: "center" };
      r.getCell(3).numFmt = "#,##0";
      r.getCell(3).alignment = { horizontal: "right" };
      r.getCell(4).numFmt = "#,##0";
      r.getCell(4).alignment = { horizontal: "center" };
      r.getCell(5).numFmt = "#,##0";
      r.getCell(5).alignment = { horizontal: "right" };
      r.getCell(5).font = { bold: true };

      r.eachCell((c) => {
        c.border = thinBorder;
        c.font = { name: "Arial", size: 9.5 };
      });
      dRowIdx++;
    });

    // Summary row for dishes
    const dishTotalRow = wsDishes.getRow(dRowIdx);
    wsDishes.mergeCells(`A${dRowIdx}:C${dRowIdx}`);
    wsDishes.getCell(`A${dRowIdx}`).value = "TỔNG CỘNG";
    wsDishes.getCell(`A${dRowIdx}`).alignment = { horizontal: "right" };
    wsDishes.getCell(`A${dRowIdx}`).font = { bold: true, color: { argb: "FFC0392B" } };

    if (topDishes.length > 0) {
      dishTotalRow.getCell(4).value = { formula: `SUM(D4:D${dRowIdx - 1})` };
      dishTotalRow.getCell(5).value = { formula: `SUM(E4:E${dRowIdx - 1})` };
    } else {
      dishTotalRow.getCell(4).value = 0;
      dishTotalRow.getCell(5).value = 0;
    }
    dishTotalRow.getCell(4).numFmt = "#,##0";
    dishTotalRow.getCell(4).alignment = { horizontal: "center" };
    dishTotalRow.getCell(5).numFmt = "#,##0";
    dishTotalRow.getCell(5).alignment = { horizontal: "right" };
    dishTotalRow.getCell(4).font = { bold: true, color: { argb: "FFC0392B" } };
    dishTotalRow.getCell(5).font = { bold: true, color: { argb: "FFC0392B" } };
    dishTotalRow.eachCell((c) => {
      c.fill = totalRowFill;
      c.border = doubleBottomBorder;
    });

    // ───────────────────────────────────────────
    // SHEET 4: PHƯƠNG THỨC THANH TOÁN
    // ───────────────────────────────────────────
    const wsPay = workbook.addWorksheet("4. Hình Thức Thanh Toán", {
      views: [{ showGridLines: true }],
    });
    wsPay.columns = [
      { key: "stt", width: 6 },
      { key: "method", width: 28 },
      { key: "count", width: 18 },
      { key: "amount", width: 22 },
      { key: "pct", width: 18 },
    ];

    wsPay.mergeCells("A1:E1");
    const payT = wsPay.getCell("A1");
    payT.value = "CƠ CẤU DOANH THU THEO HÌNH THỨC THANH TOÁN";
    payT.font = { name: "Arial", size: 13, bold: true, color: { argb: "FFFFFFFF" } };
    payT.fill = titleFill;
    payT.alignment = { vertical: "middle", horizontal: "center" };
    wsPay.getRow(1).height = 28;

    const payHeader = wsPay.getRow(3);
    payHeader.values = ["STT", "Hình Thức Thanh Toán", "Số Lượt Giao Dịch", "Tổng Doanh Thu (VNĐ)", "Tỷ Trọng (%)"];
    payHeader.height = 24;
    payHeader.eachCell((c) => {
      c.fill = subHeaderFill;
      c.font = headerFont;
      c.alignment = { vertical: "middle", horizontal: "center" };
      c.border = thinBorder;
    });

    let pRowIdx = 4;
    let pCount = 1;
    paymentBreakdownMap.forEach((val, key) => {
      const label = methodLabels[key] || key;
      const r = wsPay.getRow(pRowIdx);
      r.values = [
        pCount++,
        label,
        Number(val.count),
        Number(val.amount),
        { formula: `IF(SUM(D$4:D$10)>0, D${pRowIdx}/SUM(D$4:D$10), 0)` },
      ];
      r.getCell(1).alignment = { horizontal: "center" };
      r.getCell(3).numFmt = "#,##0";
      r.getCell(3).alignment = { horizontal: "center" };
      r.getCell(4).numFmt = "#,##0";
      r.getCell(4).alignment = { horizontal: "right" };
      r.getCell(5).numFmt = "0.0%";
      r.getCell(5).alignment = { horizontal: "right" };

      r.eachCell((c) => {
        c.border = thinBorder;
        c.font = { name: "Arial", size: 9.5 };
      });
      pRowIdx++;
    });

    const payTotalRow = wsPay.getRow(pRowIdx);
    wsPay.mergeCells(`A${pRowIdx}:B${pRowIdx}`);
    wsPay.getCell(`A${pRowIdx}`).value = "TỔNG CỘNG";
    wsPay.getCell(`A${pRowIdx}`).alignment = { horizontal: "right" };
    wsPay.getCell(`A${pRowIdx}`).font = { bold: true, color: { argb: "FFC0392B" } };

    if (paymentBreakdownMap.size > 0) {
      payTotalRow.getCell(3).value = { formula: `SUM(C4:C${pRowIdx - 1})` };
      payTotalRow.getCell(4).value = { formula: `SUM(D4:D${pRowIdx - 1})` };
      payTotalRow.getCell(5).value = { formula: `SUM(E4:E${pRowIdx - 1})` };
    } else {
      payTotalRow.getCell(3).value = 0;
      payTotalRow.getCell(4).value = 0;
      payTotalRow.getCell(5).value = 0;
    }
    payTotalRow.getCell(3).numFmt = "#,##0";
    payTotalRow.getCell(3).alignment = { horizontal: "center" };
    payTotalRow.getCell(4).numFmt = "#,##0";
    payTotalRow.getCell(4).alignment = { horizontal: "right" };
    payTotalRow.getCell(5).numFmt = "0.0%";
    payTotalRow.getCell(5).alignment = { horizontal: "right" };
    payTotalRow.getCell(3).font = { bold: true, color: { argb: "FFC0392B" } };
    payTotalRow.getCell(4).font = { bold: true, color: { argb: "FFC0392B" } };
    payTotalRow.getCell(5).font = { bold: true, color: { argb: "FFC0392B" } };
    payTotalRow.eachCell((c) => {
      c.fill = totalRowFill;
      c.border = doubleBottomBorder;
    });

    // ───────────────────────────────────────────
    // SHEET 5: PHÂN BỔ GIỜ CAO ĐIỂM
    // ───────────────────────────────────────────
    const wsPeak = workbook.addWorksheet("5. Giờ Cao Điểm", {
      views: [{ showGridLines: true }],
    });
    wsPeak.columns = [
      { key: "hour", width: 14 },
      { key: "orders", width: 18 },
      { key: "rev", width: 22 },
      { key: "tag", width: 28 },
    ];

    wsPeak.mergeCells("A1:D1");
    const peakT = wsPeak.getCell("A1");
    peakT.value = "PHÂN TÍCH DOANH THU THEO TỪNG KHUNG GIỜ (PEAK HOURS)";
    peakT.font = { name: "Arial", size: 13, bold: true, color: { argb: "FFFFFFFF" } };
    peakT.fill = titleFill;
    peakT.alignment = { vertical: "middle", horizontal: "center" };
    wsPeak.getRow(1).height = 28;

    const peakHeader = wsPeak.getRow(3);
    peakHeader.values = ["Khung Giờ", "Số Lượt Đơn", "Doanh Thu (VNĐ)", "Đánh Giá Mật Độ"];
    peakHeader.height = 24;
    peakHeader.eachCell((c) => {
      c.fill = subHeaderFill;
      c.font = headerFont;
      c.alignment = { vertical: "middle", horizontal: "center" };
      c.border = thinBorder;
    });

    let pkRowIdx = 4;
    for (let h = 8; h <= 23; h++) {
      const m = peakMap.get(h);
      const count = m ? m.orderCount : 0;
      const rev = m ? m.totalRevenue : 0;
      let tag = "Bình thường";
      if (h >= 11 && h <= 13) tag = "🔥 GIỜ CAO ĐIỂM (Ca Trưa)";
      else if (h >= 18 && h <= 21) tag = "🔥 GIỜ CAO ĐIỂM (Ca Tối)";

      const r = wsPeak.getRow(pkRowIdx);
      r.values = [`${String(h).padStart(2, "0")}:00`, Number(count), Number(rev), tag];
      r.getCell(1).alignment = { horizontal: "center" };
      r.getCell(2).numFmt = "#,##0";
      r.getCell(2).alignment = { horizontal: "center" };
      r.getCell(3).numFmt = "#,##0";
      r.getCell(3).alignment = { horizontal: "right" };

      if (tag.includes("GIỜ CAO ĐIỂM")) {
        r.getCell(4).font = { color: { argb: "FFC0392B" }, bold: true };
      }

      r.eachCell((c) => {
        c.border = thinBorder;
        c.font = { name: "Arial", size: 9.5 };
      });
      pkRowIdx++;
    }

    const peakTotalRow = wsPeak.getRow(pkRowIdx);
    peakTotalRow.getCell(1).value = "TỔNG CỘNG";
    peakTotalRow.getCell(1).alignment = { horizontal: "center" };
    peakTotalRow.getCell(1).font = { bold: true, color: { argb: "FFC0392B" } };
    peakTotalRow.getCell(2).value = { formula: `SUM(B4:B${pkRowIdx - 1})` };
    peakTotalRow.getCell(3).value = { formula: `SUM(C4:C${pkRowIdx - 1})` };
    peakTotalRow.getCell(2).numFmt = "#,##0";
    peakTotalRow.getCell(3).numFmt = "#,##0";
    peakTotalRow.getCell(2).alignment = { horizontal: "center" };
    peakTotalRow.getCell(3).alignment = { horizontal: "right" };
    peakTotalRow.getCell(2).font = { bold: true, color: { argb: "FFC0392B" } };
    peakTotalRow.getCell(3).font = { bold: true, color: { argb: "FFC0392B" } };
    peakTotalRow.eachCell((c) => {
      c.fill = totalRowFill;
      c.border = doubleBottomBorder;
    });

    // OUTPUT FILE AS NATIVE EXCEL .XLSX
    const filename = `Bao_Cao_Doanh_Thu_3Mien_${startDate || "all"}_den_${endDate || "today"}.xlsx`;
    res.setHeader(
      "Content-Type",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    );
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);

    await workbook.xlsx.write(res);
    res.end();
  } catch (error) {
    next(error);
  }
};