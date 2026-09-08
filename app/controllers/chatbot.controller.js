const jwt = require("jsonwebtoken");
const config = require("../config");
const User = require("../models/user.model");
const Reservation = require("../models/reservation.model");
const Table = require("../models/table.model");
const Area = require("../models/area.model");
const Dish = require("../models/dish.model");
const Category = require("../models/category.model");
const RestaurantSetting = require("../models/setting.model");
const AppError = require("../app-error");

const ragService = require("../services/rag.service");
const geminiService = require("../services/gemini.service");
const tableEngine = require("../utils/table-engine");
const { generateVietQRUrl, generateCheckInQRUrl } = require("../utils/vietqr");
const { emitEvent } = require("../socket");

/**
 * Controller Chatbot: Bộ điều phối kiến trúc RAG + Gemini + Table Graph Engine
 */

// 1. Endpoint xử lý trò chuyện & tư vấn thông minh từ AI RAG
exports.processChat = async (req, res, next) => {
  try {
    const { prompt, currentBookingContext, customerName, customerPhone } = req.body;

    if (!prompt || !prompt.trim()) {
      return next(new AppError("Vui lòng nhập nội dung tin nhắn", 400));
    }

    const text = prompt.trim();

    // ═══ BƯỚC 1: TRUY XUẤT TRI THỨC THỜI GIAN THỰC (RETRIEVAL) ═══
    const ragContext = await ragService.buildRAGContext(text);

    // ═══ BƯỚC 2: TẠO CÂU TRẢ LỜI & BÓC TÁCH Ý ĐỊNH VỚI GEMINI / RAG ═══
    const aiResult = await geminiService.generateRAGResponse({
      userPrompt: text,
      ragContext,
      currentBookingContext,
    });

    const isBooking = aiResult.extractedData?.isBooking || aiResult.intent === "BOOKING_PREVIEW";
    const isMenu = aiResult.intent === "MENU_RECOMMENDATION";

    // ═══ KỊCH BẢN 1: TƯ VẤN THỰC ĐƠN ═══
    if (isMenu && !isBooking) {
      let filteredDishes = await Dish.find({ availability: true }).limit(6);
      if (/miền bắc|bắc/i.test(text)) {
        filteredDishes = await Dish.find({ availability: true, region: "Bắc" }).limit(6);
      } else if (/miền trung|trung/i.test(text)) {
        filteredDishes = await Dish.find({ availability: true, region: "Trung" }).limit(6);
      } else if (/miền nam|nam/i.test(text)) {
        filteredDishes = await Dish.find({ availability: true, region: "Nam" }).limit(6);
      }

      return res.status(200).json({
        status: "success",
        source: aiResult.source,
        reply: aiResult.reply,
        intent: "MENU_RECOMMENDATION",
        dishes: filteredDishes,
      });
    }

    // ═══ KỊCH BẢN 2: XỬ LÝ ĐẶT BÀN & GHÉP BÀN TỰ ĐỘNG ═══
    if (isBooking) {
      const extracted = aiResult.extractedData || {};
      const guests = extracted.guestsCount || 2;

      // Tính toán thời gian bắt đầu
      const startTime = new Date();
      if (extracted.dateOffsetDays) {
        startTime.setDate(startTime.getDate() + extracted.dateOffsetDays);
      }
      const targetHours = extracted.hours !== undefined ? extracted.hours : 19;
      const targetMinutes = extracted.minutes !== undefined ? extracted.minutes : 0;
      startTime.setHours(targetHours, targetMinutes, 0, 0);

      // Nếu giờ hôm nay đã qua thì tự động chuyển sang ngày mai
      if (startTime <= new Date() && (!extracted.dateOffsetDays || extracted.dateOffsetDays === 0)) {
        startTime.setDate(startTime.getDate() + 1);
      }

      const durationMinutes = ragContext.policies?.durationMinutes || 120;
      const endTime = new Date(startTime.getTime() + durationMinutes * 60000);

      // Tra cứu và liên kết các món ăn đặt trước
      const dishDict = ragContext.dishDictionary || [];
      const preOrderDishes = [];
      let preOrderSubtotal = 0;

      // Hợp nhất món từ context trước đó nếu có
      const existingDishes = currentBookingContext?.preOrderDishes || [];
      const mergedDishMap = new Map();

      existingDishes.forEach((d) => {
        const id = (d.dishId || d._id)?.toString();
        if (id) mergedDishMap.set(id, { ...d });
      });

      // Thêm các món mới do AI bóc tách được
      if (Array.isArray(extracted.dishes)) {
        for (const item of extracted.dishes) {
          const matched = dishDict.find((d) =>
            d.name.toLowerCase().includes(item.dishName.toLowerCase()) ||
            item.dishName.toLowerCase().includes(d.name.toLowerCase())
          );
          if (matched) {
            const qty = item.quantity || 1;
            mergedDishMap.set(matched.id, {
              dishId: matched.id,
              dishName: matched.name,
              price: matched.price,
              quantity: qty,
            });
          }
        }
      }

      mergedDishMap.forEach((val) => {
        preOrderDishes.push(val);
        preOrderSubtotal += val.price * val.quantity;
      });

      // Kiểm tra bàn trống và chạy thuật toán xếp bàn / ghép bàn
      const occupiedTableIds = await tableEngine.getOccupiedTableIds(startTime, endTime);
      const allTables = await Table.find({ isActive: { $ne: false }, status: { $ne: "MAINTENANCE" } }).populate("area", "name");
      const availableTables = allTables.filter((t) => !occupiedTableIds.has(t._id.toString()));

      let assignedTables = [];
      let isCombined = false;
      let tableDetails = [];

      const singleMatches = availableTables.filter((t) => t.capacity >= guests).sort((a, b) => a.capacity - b.capacity);

      if (singleMatches.length > 0 && guests <= 8) {
        assignedTables = [singleMatches[0]._id];
        tableDetails = [singleMatches[0]];
      } else {
        // Thuật toán ghép cụm bàn kề nhau qua Graph BFS
        const combinations = await tableEngine.findCombinations(availableTables, guests);
        if (combinations.length > 0) {
          combinations.sort((a, b) => a.totalCapacity - b.totalCapacity);
          assignedTables = combinations[0].tables.map((t) => t._id);
          tableDetails = combinations[0].tables;
          isCombined = true;
        } else if (singleMatches.length > 0) {
          assignedTables = [singleMatches[0]._id];
          tableDetails = [singleMatches[0]];
        }
      }

      if (assignedTables.length === 0) {
        const timeStr = startTime.toLocaleTimeString("vi-VN", { hour: "2-digit", minute: "2-digit" });
        const dateStr = startTime.toLocaleDateString("vi-VN");
        return res.status(200).json({
          status: "success",
          source: aiResult.source,
          reply: `Dạ em rất tiếc! Khung giờ **${timeStr} ngày ${dateStr}** nhà hàng đã kín bàn cho đoàn **${guests} người**.\n\nAnh/Chị có thể chọn khung giờ khác để em kiểm tra bàn trống ngay giúp mình nhé!`,
          intent: "NO_TABLE_AVAILABLE",
        });
      }

      // Tính tiền đặt cọc
      let depositAmount = 0;
      if (preOrderSubtotal > 0) {
        depositAmount = Math.round((preOrderSubtotal * 0.5) / 1000) * 1000;
      } else if (guests >= 4) {
        depositAmount = ragContext.policies?.defaultDepositAmount || 100000;
      }

      const tableNames = tableDetails.map((t) => `Bàn ${t.tableNumber} (${t.capacity} chỗ)`).join(" + ");
      const areaName = tableDetails[0]?.area?.name || "Khu vực chính";
      const totalCapacity = tableDetails.reduce((sum, t) => sum + (t.capacity || 0), 0);
      const timeFormatted = startTime.toLocaleTimeString("vi-VN", { hour: "2-digit", minute: "2-digit" });
      const dateFormatted = startTime.toLocaleDateString("vi-VN");

      let reply = aiResult.reply;
      if (aiResult.source === "LOCAL_NLP_FALLBACK" || !reply) {
        reply = `🦀 **Em đã tìm và xếp bàn sẵn sàng cho Anh/Chị:**\n\n`;
        reply += `👥 **Số lượng:** ${guests} người\n`;
        reply += `⏰ **Thời gian:** ${timeFormatted} — Ngày ${dateFormatted}\n`;
        reply += `🪑 **Vị trí bàn:** ${tableNames} — *Khu vực: ${areaName}* (Tổng ${totalCapacity} chỗ)\n`;
        if (isCombined) {
          reply += `\n🔗 **Hỗ trợ ghép bàn:** Tự động ghép cụm bàn kề nhau để đoàn ngồi liền mạch ấm cúng nhất!\n`;
        }
        if (preOrderDishes.length > 0) {
          reply += `\n🍽️ **Món ăn đặt trước (${preOrderDishes.length} món):**\n`;
          preOrderDishes.forEach((d) => {
            reply += `• ${d.dishName} x ${d.quantity} phần (${(d.price * d.quantity).toLocaleString("vi-VN")}đ)\n`;
          });
          reply += `💵 **Tổng tiền món:** ${preOrderSubtotal.toLocaleString("vi-VN")}đ\n`;
        }
        if (depositAmount > 0) {
          reply += `\n💳 **Tiền cọc giữ chỗ:** \`${depositAmount.toLocaleString("vi-VN")}đ\`\n`;
        }
        reply += `\n👇 **Anh/Chị kiểm tra thông tin trên thẻ xem trước và bấm "Xác Nhận Đặt Bàn Ngay" để hoàn tất nhé!**`;
      }

      return res.status(200).json({
        status: "success",
        source: aiResult.source,
        reply,
        intent: "BOOKING_PREVIEW",
        bookingData: {
          guestsCount: guests,
          startAt: startTime.toISOString(),
          endAt: endTime.toISOString(),
          formattedTime: timeFormatted,
          formattedDate: dateFormatted,
          tableIds: assignedTables.map((t) => t.toString()),
          tableNames,
          areaName,
          totalCapacity,
          isCombined,
          preOrderDishes,
          preOrderSubtotal,
          depositAmount,
        },
      });
    }

    // ═══ KỊCH BẢN 3: TƯ VẤN CHUNG ═══
    return res.status(200).json({
      status: "success",
      source: aiResult.source,
      reply: aiResult.reply,
      intent: "GENERAL_HELP",
    });
  } catch (error) {
    next(error);
  }
};

// 2. Endpoint xác nhận tạo đơn đặt bàn chính thức từ Chatbox (1-Click Booking)
exports.confirmBookingFromChat = async (req, res, next) => {
  try {
    const {
      customerName,
      customerPhone,
      customerEmail,
      guestsCount,
      startAt,
      endAt,
      tableIds,
      preOrderDishes,
      depositAmount,
      notes,
    } = req.body;

    if (!customerName || !customerPhone || !startAt || !tableIds || tableIds.length === 0) {
      return next(new AppError("Vui lòng cung cấp đầy đủ họ tên, số điện thoại, ngày giờ và bàn cần đặt", 400));
    }

    const startTime = new Date(startAt);
    const endTime = endAt ? new Date(endAt) : new Date(startTime.getTime() + 120 * 60000);

    // Kiểm tra trùng bàn đồng thời (Double-booking check)
    const conflictReservation = await Reservation.findOne({
      status: { $in: ["PENDING", "CONFIRMED", "ARRIVED"] },
      tables: { $in: tableIds },
      startAt: { $lt: endTime },
      endAt: { $gt: startTime },
    });

    if (conflictReservation) {
      return next(new AppError("Bàn bạn chọn vừa được khách khác đặt trước một khoảnh khắc. Vui lòng chọn lại khung giờ khác!", 409));
    }

    // Sinh mã đặt bàn duy nhất
    let reservationCode;
    let isUnique = false;
    while (!isUnique) {
      reservationCode = `RES-${Math.floor(100000 + Math.random() * 900000)}`;
      const existing = await Reservation.findOne({ reservationCode });
      if (!existing) isUnique = true;
    }

    const formattedDishes = (preOrderDishes || []).map((it) => ({
      dish: it.dishId || it.dish?._id || it.dish,
      quantity: it.quantity || 1,
      priceAtBooking: it.price || 0,
      notes: "Món đặt trước qua Trợ Lý AI 3 Miền Cua",
    }));

    // Tự động nhận diện tài khoản người dùng nếu có token
    let bookingUser = req.user || null;
    if (!bookingUser && req.headers.authorization && req.headers.authorization.startsWith("Bearer ")) {
      try {
        const token = req.headers.authorization.split(" ")[1];
        const decoded = jwt.verify(token, config.jwtSecret);
        if (decoded && decoded.id) {
          bookingUser = await User.findById(decoded.id);
        }
      } catch (e) {
        // Tiếp tục với tư cách khách vãng lai
      }
    }

    const newReservation = await Reservation.create({
      reservationCode,
      user: bookingUser ? bookingUser._id : null,
      customerName: customerName.trim(),
      customerPhone: customerPhone.trim(),
      customerEmail: customerEmail ? customerEmail.trim() : (bookingUser ? bookingUser.email : ""),
      guestsCount: parseInt(guestsCount, 10) || 2,
      startAt: startTime,
      endAt: endTime,
      status: "CONFIRMED",
      tables: tableIds,
      isCombined: tableIds.length > 1,
      preOrderDishes: formattedDishes,
      depositAmount: depositAmount || 0,
      notes: notes ? notes.trim() : "Đặt bàn trực tiếp qua Trợ Lý AI 3 Miền Cua (RAG Gemini)",
    });

    const populatedReservation = await Reservation.findById(newReservation._id)
      .populate("tables", "tableNumber capacity area")
      .populate("preOrderDishes.dish", "name price image");

    const settings = await RestaurantSetting.findOne();
    const bankInfo = settings?.bankAccount || { bankId: "MB", accountNo: "0988776655", accountName: "NHA HANG 3 MIEN CUA" };

    const checkInQrUrl = generateCheckInQRUrl(reservationCode);
    const qrCodeUrl = (depositAmount > 0)
      ? generateVietQRUrl(bankInfo.bankId, bankInfo.accountNo, bankInfo.accountName, depositAmount, `COC ${reservationCode}`)
      : null;

    emitEvent("reservations:changed");

    res.status(201).json({
      status: "success",
      message: "Đặt bàn thành công! Hệ thống đã xác nhận giữ chỗ cho bạn.",
      reservationCode,
      checkInQrUrl,
      deposit: {
        amount: depositAmount || 0,
        status: "UNPAID",
        bankInfo,
        qrCodeUrl,
      },
      data: { reservation: populatedReservation },
    });
  } catch (error) {
    next(error);
  }
};
