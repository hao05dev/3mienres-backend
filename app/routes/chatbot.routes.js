const express = require("express");
const chatbotController = require("../controllers/chatbot.controller");

const router = express.Router();

// Route trò chuyện AI Chatbot (Công khai cho cả khách chưa đăng nhập)
router.post("/chat", chatbotController.processChat);

// Route xác nhận đặt bàn trực tiếp từ Chatbox (1-Click Booking)
router.post("/confirm-booking", chatbotController.confirmBookingFromChat);

module.exports = router;
