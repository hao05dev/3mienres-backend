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
const tableEngine = require("../utils/table-engine");
const { generateVietQRUrl, generateCheckInQRUrl } = require("../utils/vietqr");
const { emitEvent } = require("../socket");

// Helper: Phân tích số người từ tin nhắn
const extractGuests = (text) => {
  const match = text.match(/(\d+)\s*(người|khách|chỗ|bạn|nguoi|khach|cho)/i);
  if (match) return parseInt(match[1], 10);
  const wordsMap = { "hai": 2, "ba": 3, "bốn": 4, "bon": 4, "năm": 5, "nam": 5, "sáu": 6, "sau": 6, "bảy": 7, "bay": 7, "tám": 8, "tam": 8, "chín": 9, "chin": 9, "mười": 10, "muoi": 10 };
  for (let w in wordsMap) {
    if (new RegExp(`\\b${w}\\s*(người|khách|chỗ)\\b`, "i").test(text)) return wordsMap[w];
  }
  const numOnly = text.match(/\b(\d{1,2})\b/);
  return numOnly ? parseInt(numOnly[1], 10) : 2;
};

// Helper: Phân tích ngày giờ thông minh
const extractDateTime = (text) => {
  const now = new Date();
  let targetDate = new Date(now);

  // 1. Phân tích Ngày
  if (/hôm nay|toi nay|tối nay|trua nay|trưa nay/i.test(text)) {
    // Giữ nguyên ngày hôm nay
  } else if (/tối mai|ngày mai|chiều mai|sáng mai|ngay mai/i.test(text)) {
    targetDate.setDate(targetDate.getDate() + 1);
  } else if (/ngày mốt|ngày kia|ngay mot|ngay kia/i.test(text)) {
    targetDate.setDate(targetDate.getDate() + 2);
  } else {
    // Tìm ngày cụ thể: dd/mm hoặc dd-mm
    const dateMatch = text.match(/(\d{1,2})[\/\-](\d{1,2})/);
    if (dateMatch) {
      const day = parseInt(dateMatch[1], 10);
      const month = parseInt(dateMatch[2], 10) - 1;
      targetDate.setMonth(month, day);
      if (targetDate < now) {
        targetDate.setFullYear(targetDate.getFullYear() + 1);
      }
    }
  }

  // 2. Phân tích Giờ
  const timeMatch = text.match(/(\d{1,2})\s*(h|gờ|:|gio|giờ)\s*(\d{2})?/i);
  let hours = 19; // Mặc định 19h tối
  let minutes = 0;

  if (timeMatch) {
    hours = parseInt(timeMatch[1], 10);
    if (timeMatch[3]) minutes = parseInt(timeMatch[3], 10);
    if (/tối|đêm|chiều|toi|dem|chieu/i.test(text) && hours < 12) hours += 12;
    if (/trưa|trua/i.test(text) && hours < 11) hours += 12;
  } else if (/trưa|trua/i.test(text)) {
    hours = 12;
  }

  targetDate.setHours(hours, minutes, 0, 0);

  // Nếu thời gian hôm nay đã trôi qua thì tự động chuyển sang ngày mai
  if (targetDate <= now) {
    targetDate.setDate(targetDate.getDate() + 1);
  }

  return targetDate;
};

// Helper: Xóa dấu tiếng Việt phục vụ tìm kiếm linh hoạt
const removeVietnameseTones = (str) => {
  return (str || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/đ/g, "d")
    .replace(/Đ/g, "D")
    .toLowerCase();
};

// Helper: Phân tích các món ăn khách nhắc tới hoặc thêm từ ngữ cảnh
const extractDishesFromPrompt = async (text, existingDishes = []) => {
  const allDishes = await Dish.find({ availability: true }).populate("category", "name");
  const detectedMap = new Map();

  // Giữ lại các món đã chọn trước đó nếu có
  if (Array.isArray(existingDishes)) {
    for (let it of existingDishes) {
      const dId = (it.dishId || it._id || it.dish?._id || it.dish)?.toString();
      if (dId) {
        detectedMap.set(dId, {
          dishId: dId,
          dishName: it.dishName || it.name,
          price: it.price || 0,
          image: it.image,
          region: it.region,
          quantity: it.quantity || 1,
        });
      }
    }
  }

  const cleanText = (text || "").toLowerCase();
  const rawTextNoTone = removeVietnameseTones(cleanText);

  for (let d of allDishes) {
    const rawDishName = d.name.toLowerCase();
    const dishNoTone = removeVietnameseTones(d.name);

    // Rút gọn các từ vùng miền/hậu tố bổ sung để tăng độ khớp
    const simplified = rawDishName.replace(/(cà mau|bắc bộ|đặc sản|cay nồng|béo ngậy|xiêm|cố đô|ba trái|hải sản cay nồng|bún tươi tẩy)/gi, "").trim();
    const simplifiedNoTone = removeVietnameseTones(simplified);

    const patterns = [
      rawDishName,
      dishNoTone,
      simplified,
      simplifiedNoTone
    ].filter((p) => p && p.length >= 3);

    let isMatch = false;
    let matchedKeyword = "";

    for (let pat of patterns) {
      if (cleanText.includes(pat) || rawTextNoTone.includes(pat)) {
        isMatch = true;
        matchedKeyword = pat;
        break;
      }
    }

    if (isMatch) {
      let quantity = 1;
      const escaped = matchedKeyword.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const qtyBefore = cleanText.match(new RegExp(`(\\d+)\\s*(phần|đĩa|suất|nồi|ly|chai|con|bát|tô|x)?\\s*${escaped}`, "i")) ||
                        rawTextNoTone.match(new RegExp(`(\\d+)\\s*(phan|dia|suat|noi|ly|chai|con|bat|to|x)?\\s*${escaped}`, "i"));

      const qtyAfter = cleanText.match(new RegExp(`${escaped}\\s*(x|\\*|:)?\\s*(\\d+)`, "i")) ||
                       rawTextNoTone.match(new RegExp(`${escaped}\\s*(x|\\*|:)?\\s*(\\d+)`, "i"));

      if (qtyBefore && qtyBefore[1]) {
        quantity = parseInt(qtyBefore[1], 10);
      } else if (qtyAfter && qtyAfter[2]) {
        quantity = parseInt(qtyAfter[2], 10);
      }

      detectedMap.set(d._id.toString(), {
        dishId: d._id.toString(),
        dishName: d.name,
        price: d.price,
        image: d.image,
        region: d.region,
        quantity: Math.max(1, quantity),
      });
    }
  }

  return Array.from(detectedMap.values());
};

// 1. Trò chuyện & Xử lý yêu cầu thông minh từ AI Chatbot
exports.processChat = async (req, res, next) => {
  try {
    const { prompt, currentBookingContext, customerName, customerPhone } = req.body;

    if (!prompt || !prompt.trim()) {
      return next(new AppError("Vui lòng nhập nội dung tin nhắn", 400));
    }

    const text = prompt.trim();
    const isBookingIntent = /đặt bàn|giữ chỗ|bàn cho|đặt chỗ|đặt 1 bàn|đặt hai bàn|dat ban|giu cho|book|booking|ghép bàn|ghep ban/i.test(text);
    const isMenuIntent = /thực đơn|menu|món ăn|có món gì|đặc sản|thuc don|mon ngon|goi y mon|gợi ý món/i.test(text);
    const isConfirmIntent = /đồng ý|xác nhận|chốt đơn|ok đặt|ok dat|chot don/i.test(text);

    // Lấy cài đặt nhà hàng
    const settings = await RestaurantSetting.findOne();
    const durationMinutes = settings?.reservation?.defaultDurationMinutes || 120;
    const defaultDeposit = settings?.reservation?.defaultDepositAmount || 100000;
    const bankInfo = settings?.bankAccount || { bankId: "MB", accountNo: "0988776655", accountName: "NHA HANG 3 MIEN CUA" };

    // ═══ KỊCH BẢN 1: TƯ VẤN THỰC ĐƠN & GỢI Ý MÓN ĂN ═══
    if (isMenuIntent && !isBookingIntent) {
      let filter = { availability: true };
      let regionLabel = "cả 3 miền";

      if (/miền bắc|mien bac|bắc bộ/i.test(text)) {
        filter.region = "Bắc";
        regionLabel = "Đặc Sản Miền Bắc";
      } else if (/miền trung|mien trung|huế|đà nẵng/i.test(text)) {
        filter.region = "Trung";
        regionLabel = "Đặc Sản Miền Trung";
      } else if (/miền nam|mien nam|cà mau|sài gòn/i.test(text)) {
        filter.region = "Nam";
        regionLabel = "Đặc Sản Miền Nam";
      } else if (/cua|hải sản|seafood/i.test(text)) {
        filter.name = { $regex: /cua|hải sản|tôm/i };
        regionLabel = "Đặc Sản Cua & Hải Sản";
      }

      const dishes = await Dish.find(filter).limit(6);
      let reply = `🦀 **Nhà hàng 3 Miền Cua xin gợi ý các món ${regionLabel} hấp dẫn nhất:**\n\n`;
      dishes.forEach((d, idx) => {
        reply += `${idx + 1}. **${d.name}** (${d.region}) — \`${d.price.toLocaleString("vi-VN")}đ\`\n`;
        if (d.description) reply += `   *${d.description.slice(0, 70)}...*\n`;
      });
      reply += `\n💡 *Anh/Chị muốn đặt bàn thưởng thức món nào, chỉ cần nhắn ví dụ:* **"Đặt bàn 6 người lúc 19h tối mai, ăn Cua rang me và Lẩu cua"** *để em chuẩn bị chu đáo nhé!*`;

      return res.status(200).json({
        status: "success",
        reply,
        intent: "MENU_RECOMMENDATION",
        dishes,
      });
    }

    // ═══ KỊCH BẢN 2: XỬ LÝ ĐẶT BÀN & GHÉP BÀN TỰ ĐỘNG ═══
    if (isBookingIntent || isConfirmIntent) {
      const guests = extractGuests(text);
      const startTime = extractDateTime(text);
      const endTime = new Date(startTime.getTime() + durationMinutes * 60000);

      // Tra cứu các món ăn đặt trước trong prompt và ngữ cảnh trước
      const detectedDishes = await extractDishesFromPrompt(text, currentBookingContext?.preOrderDishes);

      // Kiểm tra bàn trống trong khung giờ
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
        // Thuật toán ghép cụm bàn kề nhau
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
          reply: `Dạ em rất tiếc! Khung giờ **${timeStr} ngày ${dateStr}** nhà hàng đã kín bàn cho đoàn **${guests} người**.\n\nAnh/Chị có thể đổi sang khung giờ khác (ví dụ: *${timeStr.split(":")[0] === "19" ? "17:30 hoặc 20:30" : "19:00"}*) để em kiểm tra bàn trống ngay giúp mình nhé!`,
          intent: "NO_TABLE_AVAILABLE",
        });
      }

      // Tính tiền món đặt trước & Tiền cọc
      let preOrderSubtotal = 0;
      detectedDishes.forEach((item) => {
        preOrderSubtotal += item.price * item.quantity;
      });

      let depositAmount = 0;
      if (preOrderSubtotal > 0) {
        depositAmount = Math.round((preOrderSubtotal * 0.5) / 1000) * 1000; // 50% tiền món
      } else if (guests >= 4) {
        depositAmount = defaultDeposit;
      }

      const tableNames = tableDetails.map((t) => `Bàn ${t.tableNumber} (${t.capacity} chỗ)`).join(" + ");
      const areaName = tableDetails[0]?.area?.name || "Khu vực chính";
      const totalCapacity = tableDetails.reduce((sum, t) => sum + (t.capacity || 0), 0);

      const timeFormatted = startTime.toLocaleTimeString("vi-VN", { hour: "2-digit", minute: "2-digit" });
      const dateFormatted = startTime.toLocaleDateString("vi-VN");

      let reply = `🦀 **Em đã tìm và xếp bàn sẵn sàng cho Anh/Chị:**\n\n`;
      reply += `👥 **Số lượng:** ${guests} người\n`;
      reply += `⏰ **Thời gian:** ${timeFormatted} — Ngày ${dateFormatted}\n`;
      reply += `🪑 **Vị trí bàn:** ${tableNames} — *Khu vực: ${areaName}* (Tổng ${totalCapacity} chỗ)\n`;

      if (isCombined) {
        reply += `\n🔗 **Hỗ trợ ghép bàn thông minh:** Vì đoàn ${guests} người đông nên hệ thống AI đã tự động ghép cụm bàn kề nhau để đoàn ngồi liền mạch ấm cúng nhất!\n`;
      }

      if (detectedDishes.length > 0) {
        reply += `\n🍽️ **Món ăn đặt trước (${detectedDishes.length} món):**\n`;
        detectedDishes.forEach((d) => {
          reply += `• ${d.dishName} x ${d.quantity} phần (${(d.price * d.quantity).toLocaleString("vi-VN")}đ)\n`;
        });
        reply += `💵 **Tổng tiền món:** ${preOrderSubtotal.toLocaleString("vi-VN")}đ\n`;
      }

      if (depositAmount > 0) {
        reply += `\n💳 **Tiền cọc giữ chỗ:** \`${depositAmount.toLocaleString("vi-VN")}đ\`\n`;
      }

      reply += `\n👇 **Anh/Chị kiểm tra thông tin trên thẻ xem trước bên dưới và bấm nút "Xác Nhận Đặt Bàn Ngay" để hoàn tất nhé!**`;

      return res.status(200).json({
        status: "success",
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
          preOrderDishes: detectedDishes.map((d) => ({
            dishId: d.dishId,
            dishName: d.dishName,
            price: d.price,
            image: d.image,
            quantity: d.quantity,
          })),
          preOrderSubtotal,
          depositAmount,
        },
      });
    }

    // ═══ KỊCH BẢN 3: TƯ VẤN CHUNG ═══
    return res.status(200).json({
      status: "success",
      reply: `Dạ em là **Trợ Lý AI 3 Miền Cua**! Em có thể giúp Anh/Chị:\n\n1. 🦀 **Tư vấn đặc sản 3 miền** theo khẩu vị & số người ăn.\n2. 🪑 **Tự động tìm & xếp bàn** chỉ trong 1 giây.\n3. 🔗 **Tự động ghép cụm bàn kề nhau** cho đoàn tiệc đông người (8 - 20 khách).\n4. 🍽️ **Gợi ý & chọn món đặt trước (Pre-order)** sẵn sàng trước khi đến.\n\n👉 *Anh/Chị có thể nhắn tin thử:* **"Đặt bàn 12 người tối mai 19h ghép bàn và ăn 2 Cua rang me"** *để em phục vụ ngay nhé!*`,
      intent: "GENERAL_HELP",
    });
  } catch (error) {
    next(error);
  }
};

// 2. Xác nhận tạo đơn đặt bàn chính thức từ Chatbox (1-Click Booking)
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

    // Double-Check trùng bàn đồng thời
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

    // Format danh sách món đặt trước
    const formattedDishes = (preOrderDishes || []).map((it) => ({
      dish: it.dishId || it.dish?._id || it.dish,
      quantity: it.quantity || 1,
      priceAtBooking: it.price || 0,
      notes: "Món đặt trước qua AI Chatbot",
    }));

    let bookingUser = req.user || null;
    if (!bookingUser && req.headers.authorization && req.headers.authorization.startsWith("Bearer ")) {
      try {
        const token = req.headers.authorization.split(" ")[1];
        const decoded = jwt.verify(token, config.jwtSecret);
        if (decoded && decoded.id) {
          bookingUser = await User.findById(decoded.id);
        }
      } catch (e) {
        // Continue as guest if token invalid
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
      notes: notes ? notes.trim() : "Đặt bàn trực tiếp qua Trợ Lý AI Chatbot 3 Miền Cua",
    });

    const populatedReservation = await Reservation.findById(newReservation._id)
      .populate("tables", "tableNumber capacity area")
      .populate("preOrderDishes.dish", "name price image");

    // Lấy thông tin tài khoản ngân hàng để tạo mã VietQR
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
