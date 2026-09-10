const Invoice = require("../models/invoice.model");
const Reservation = require("../models/reservation.model");
const Table = require("../models/table.model");
const Ingredient = require("../models/ingredient.model");
const Order = require("../models/order.model");
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

// Xuất báo cáo tổng hợp doanh thu & kết quả kinh doanh ra Excel CSV chuyên nghiệp
exports.exportInvoicesCsv = async (req, res, next) => {
  try {
    const { startDate, endDate } = req.query;
    const { start, end } = parseDateRange(startDate, endDate);

    // 1. Lấy danh sách hóa đơn chi tiết trong kỳ
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

    // 2. Thống kê tổng quan KPI
    const totalRevenue = invoices.reduce((sum, inv) => sum + (inv.finalAmount || 0), 0);
    const invoiceCount = invoices.length;
    const totalDiscount = invoices.reduce((sum, inv) => sum + (inv.discountAmount || 0), 0);
    const totalDepositDeducted = invoices.reduce((sum, inv) => sum + (inv.depositDeducted || 0), 0);
    const avgOrderValue = invoiceCount > 0 ? Math.round(totalRevenue / invoiceCount) : 0;

    const reservationsCount = await Reservation.countDocuments({
      createdAt: { $gte: start, $lte: end },
    });

    const totalTables = await Table.countDocuments({ isActive: true });
    const occupiedTables = await Table.countDocuments({ isActive: true, status: "OCCUPIED" });
    const occupancyRate = totalTables > 0 ? ((occupiedTables / totalTables) * 100).toFixed(1) : 0;

    // 3. Cơ cấu phương thức thanh toán
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
      VNPAY: "Cổng thanh toán VNPAY",
      MOMO: "Ví điện tử MoMo",
      CARD: "Thẻ ngân hàng / POS",
    };

    // 4. Top món ăn bán chạy
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
      { $limit: 15 },
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

    // 5. Thống kê theo khung giờ (Peak Hours)
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

    // XÂY DỰNG FILE BÁO CÁO EXCEL CSV CHUYÊN NGHIỆP
    const lines = [];

    // Header báo cáo
    lines.push(`"BÁO CÁO TỔNG HỢP DOANH THU & KẾT QUẢ KINH DOANH"`);
    lines.push(`"Đơn vị: NHÀ HÀNG 3 MIỀN CUA"`);
    lines.push(`"Thời gian báo cáo: Từ ${start.toLocaleDateString('vi-VN')} đến ${end.toLocaleDateString('vi-VN')}"`);
    lines.push(`"Thời điểm xuất file: ${new Date().toLocaleString('vi-VN')}"`);
    lines.push(`"Người xuất: ${req.user?.name || 'Quản Trị Viên'}"`);
    lines.push(`""`);

    // KHỐI 1: TỔNG HỢP CHỈ SỐ KINH DOANH
    lines.push(`"=== 1. TỔNG HỢP CHỈ SỐ KINH DOANH CHÍNH ==="`);
    lines.push(`"Chỉ Số","Giá Trị","Đơn Vị Tính"`);
    lines.push(`"Tổng Doanh Thu Thực Tế","${totalRevenue.toLocaleString('vi-VN')}","VNĐ"`);
    lines.push(`"Tổng Số Hóa Đơn Đã Thu","${invoiceCount}","Hóa đơn"`);
    lines.push(`"Doanh Thu Trung Bình / Hóa Đơn (AOV)","${avgOrderValue.toLocaleString('vi-VN')}","VNĐ/HĐ"`);
    lines.push(`"Tổng Tiền Giảm Giá / Voucher","${totalDiscount.toLocaleString('vi-VN')}","VNĐ"`);
    lines.push(`"Tổng Tiền Cọc Đã Khấu Trừ","${totalDepositDeducted.toLocaleString('vi-VN')}","VNĐ"`);
    lines.push(`"Tổng Số Lượt Đặt Bàn","${reservationsCount}","Lượt đặt"`);
    lines.push(`"Tỷ Lệ Lấp Đầy Bàn Hiện Tại","${occupancyRate}%","%"`);
    lines.push(`""`);

    // KHỐI 2: CHI TIẾT DANH SÁCH HÓA ĐƠN
    lines.push(`"=== 2. CHI TIẾT DANH SÁCH HÓA ĐƠN ĐÃ THANH TOÁN (${invoices.length} HÓA ĐƠN) ==="`);
    lines.push(`"STT","Mã Hóa Đơn","Mã Phiên Ăn","Khách Hàng","Số Điện Thoại","Bàn Ăn","Thời Gian Vào","Thời Gian Thanh Toán","Tiền Món (VNĐ)","Giảm Giá (VNĐ)","Trừ Cọc (VNĐ)","Thực Thu (VNĐ)","Phương Thức","Thu Ngân"`);
    
    invoices.forEach((inv, index) => {
      const tableNumbers = (inv.diningSession?.tables || []).map((t) => t.tableNumber).join(", ") || "Chưa gán";
      const customer = inv.diningSession?.customerName || "Khách lẻ / Vãng lai";
      const phone = inv.diningSession?.customerPhone || "";
      const sessionCode = inv.diningSession?.sessionCode || "";
      const checkInTime = inv.diningSession?.checkInTime ? new Date(inv.diningSession.checkInTime).toLocaleString("vi-VN") : "";
      const paidTime = inv.paidAt ? new Date(inv.paidAt).toLocaleString("vi-VN") : "";
      const method = methodLabels[inv.paymentMethod] || inv.paymentMethod || "Tiền mặt";
      const cashierName = inv.cashier?.name || "Thu ngân";

      lines.push(
        [
          index + 1,
          inv.invoiceCode || `INV-${inv._id.toString().slice(-6).toUpperCase()}`,
          sessionCode,
          customer,
          phone,
          tableNumbers,
          checkInTime,
          paidTime,
          inv.subtotal || 0,
          inv.discountAmount || 0,
          inv.depositDeducted || 0,
          inv.finalAmount || 0,
          method,
          cashierName,
        ]
          .map((v) => `"${String(v ?? "").replace(/"/g, '""')}"`)
          .join(",")
      );
    });
    lines.push(`""`);

    // KHỐI 3: CƠ CẤU HÌNH THỨC THANH TOÁN
    lines.push(`"=== 3. CƠ CẤU DOANH THU THEO HÌNH THỨC THANH TOÁN ==="`);
    lines.push(`"Hình Thức Thanh Toán","Số Lượt Giao Dịch","Tổng Tiền (VNĐ)","Tỷ Trọng Doanh Thu"`);
    paymentBreakdownMap.forEach((val, key) => {
      const label = methodLabels[key] || key;
      const pct = totalRevenue > 0 ? ((val.amount / totalRevenue) * 100).toFixed(1) : 0;
      lines.push(`"${label}","${val.count}","${val.amount}","${pct}%"`);
    });
    lines.push(`""`);

    // KHỐI 4: TOP MÓN ĂN BÁN CHẠY
    lines.push(`"=== 4. TOP MÓN ĂN BÁN CHẠY & DOANH SỐ TỪNG MÓN ==="`);
    lines.push(`"STT","Tên Món Ăn","Đơn Giá (VNĐ)","Số Lượng Bán","Tổng Doanh Thu Món (VNĐ)"`);
    topDishes.forEach((dish, idx) => {
      lines.push(`"${idx + 1}","${dish.name}","${dish.price || 0}","${dish.totalQuantity}","${dish.totalRevenue}"`);
    });
    lines.push(`""`);

    // KHỐI 5: PHÂN TÍCH MẬT ĐỘ THEO KHUNG GIỜ
    lines.push(`"=== 5. THỐNG KÊ DOANH SỐ THEO KHUNG GIỜ HOẠT ĐỘNG (PEAK HOURS) ==="`);
    lines.push(`"Khung Giờ","Số Lượt Đơn","Doanh Thu (VNĐ)","Đánh Giá Mật Độ Khách"`);
    for (let h = 8; h <= 23; h++) {
      const m = peakMap.get(h);
      const count = m ? m.orderCount : 0;
      const rev = m ? m.totalRevenue : 0;
      let tag = "Bình thường";
      if ((h >= 11 && h <= 13)) tag = "GIỜ CAO ĐIỂM (Ca Trưa)";
      else if ((h >= 18 && h <= 21)) tag = "GIỜ CAO ĐIỂM (Ca Tối)";
      lines.push(`"${String(h).padStart(2, "0")}:00","${count}","${rev}","${tag}"`);
    }

    const csvContent = lines.join("\r\n");

    const filename = `Bao_Cao_Doanh_Thu_3Mien_${startDate || 'all'}_den_${endDate || 'today'}.csv`;
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    res.send("\uFEFF" + csvContent);
  } catch (error) {
    next(error);
  }
};