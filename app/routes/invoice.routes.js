const express = require("express");
const invoiceController = require("../controllers/invoice.controller");
const { protect, restrictTo } = require("../utils/auth");

const router = express.Router();

router.use(protect);

// Khách hàng xem lịch sử hóa đơn của chính mình
router.get("/my-invoices", invoiceController.getMyInvoices);

// Lấy chi tiết hóa đơn theo ID (Khách hàng hoặc Nhân viên)
router.get("/:id/detail", invoiceController.getInvoiceDetail);

// Tạo hóa đơn & Thanh toán giải phóng bàn (Chỉ Staff / Manager / Admin)
router.post("/", restrictTo("staff", "manager", "admin"), invoiceController.createInvoice);

// Lấy hóa đơn của 1 lượt dùng bữa (Chỉ Staff / Manager / Admin)
router.get("/session/:sessionId", restrictTo("staff", "manager", "admin"), invoiceController.getInvoiceBySession);

// Xem tất cả hóa đơn / Thống kê doanh thu (Chỉ Staff / Manager / Admin)
router.get("/", restrictTo("staff", "manager", "admin"), invoiceController.getAllInvoices);

module.exports = router;