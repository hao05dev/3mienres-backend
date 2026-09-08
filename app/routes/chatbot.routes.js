const express = require("express");
const chatbotController = require("../controllers/chatbot.controller");

const router = express.Router();

// Route trò chuyện AI Chatbot (Công khai cho cả khách chưa đăng nhập)
router.post("/chat", chatbotController.processChat);

// Route xác nhận đặt bàn trực tiếp từ Chatbox (1-Click Booking)
router.post("/confirm-booking", chatbotController.confirmBookingFromChat);

// Route lấy các lịch đặt bàn sắp tới của khách (Tự động nhận diện bàn)
router.get("/active-reservations", chatbotController.getActiveReservations);

// Route bổ sung món ăn vào đơn đặt bàn sẵn có
router.post("/add-dishes-to-booking", chatbotController.addDishesToBooking);

module.exports = router;
