const Reservation = require("../models/reservation.model");
const Table = require("../models/table.model");
const AppError = require("../app-error");
const tableEngine = require("../utils/table-engine");
const { roundMoney } = require("../utils/money");
const { emitEvent } = require("../socket");
const notifier = require("../utils/notifier");
const { logAction } = require("../utils/audit");
const { getPagination, buildPaginationMeta, buildSearchFilter } = require("../utils/pagination");

// 1. Quản lý xem toàn bộ danh sách đơn đặt bàn (Admin/Staff)
exports.getAllReservations = async (req, res, next) => {
  try {
    const { status, date, search } = req.query;
    const filter = {};

    if (status) filter.status = status;
    if (date) {
      const startOfDay = new Date(date);
      startOfDay.setHours(0, 0, 0, 0);
      const endOfDay = new Date(date);
      endOfDay.setHours(23, 59, 59, 999);
      filter.startAt = { $gte: startOfDay, $lte: endOfDay };
    }

    const searchFilter = buildSearchFilter(search, ["reservationCode", "customerName", "customerPhone"]);
    if (searchFilter) Object.assign(filter, searchFilter);

    const { page, limit, skip } = getPagination(req.query);
    const total = await Reservation.countDocuments(filter);

    const reservations = await Reservation.find(filter)
      .populate("user", "name email phone")
      .populate("tables", "tableNumber capacity area")
      .populate("preOrderDishes.dish", "name price")
      .sort({ startAt: -1 })
      .skip(skip)
      .limit(limit);

    res.status(200).json({
      status: "success",
      results: reservations.length,
      ...buildPaginationMeta(total, page, limit),
      data: { reservations },
    });
  } catch (error) {
    next(error);
  }
};

// 2. Gán lại bàn ăn dự kiến cho đơn đặt bàn (Admin/Staff)
exports.assignTables = async (req, res, next) => {
  try {
    const { tableIds } = req.body;
    const reservation = await Reservation.findById(req.params.id);

    if (!reservation) return next(new AppError("Không tìm thấy đơn đặt bàn này", 404));
    if (!Array.isArray(tableIds) || tableIds.length === 0) {
      return next(new AppError("Vui lòng cung cấp danh sách bàn hợp lệ", 400));
    }

    for (const tableId of tableIds) {
      const table = await Table.findById(tableId);
      if (!table) return next(new AppError(`Bàn với ID '${tableId}' không tồn tại`, 404));
    }

    // Kiểm tra các bàn gán phải nằm cạnh nhau mới ghép được
    if (tableIds.length > 1) {
      const mergeCheck = await tableEngine.validateMergeableTables(tableIds);
      if (!mergeCheck.isValid) {
        return next(new AppError("Các bàn được gán không nằm cạnh nhau nên không thể ghép. Vui lòng chọn bàn kề nhau.", 400));
      }
    }

    reservation.tables = tableIds;
    reservation.status = "CONFIRMED";
    await reservation.save();

    emitEvent("reservations:changed");

    res.status(200).json({
      status: "success",
      message: "Gán bàn dự kiến thành công",
      data: { reservation },
    });
  } catch (error) {
    next(error);
  }
};

// 3. Nhân viên xác nhận khách đã nộp cọc tại quầy hoặc chuyển khoản
exports.confirmDeposit = async (req, res, next) => {
  try {
    const reservation = await Reservation.findById(req.params.id);
    if (!reservation) return next(new AppError("Không tìm thấy đơn đặt bàn này", 404));

    if (reservation.depositAmount <= 0) {
      return next(new AppError("Đơn đặt bàn này không yêu cầu tiền cọc", 400));
    }
    if (["CANCELLED", "COMPLETED"].includes(reservation.status)) {
      return next(new AppError(`Đơn đặt bàn đang ở trạng thái '${reservation.status}', không thể xác nhận cọc`, 409));
    }
    if (reservation.depositStatus === "PAID") {
      return next(new AppError("Đơn đặt bàn này đã được xác nhận cọc", 409));
    }

    const { paymentMethod = "CASH" } = req.body;

    reservation.depositStatus = "PAID";
    reservation.depositMethod = paymentMethod;
    reservation.depositConfirmedAt = new Date();
    reservation.depositConfirmedBy = req.user ? req.user._id : null;
    await reservation.save();

    emitEvent("reservations:changed");
    notifier.notifyDepositConfirmed(reservation);
    logAction(req, "CONFIRM_DEPOSIT", "Reservation", reservation._id, {
      reservationCode: reservation.reservationCode,
      amount: reservation.depositAmount,
      method: paymentMethod,
    });

    const methodName = paymentMethod === "CASH" ? "Tiền mặt tại quầy" : "Chuyển khoản VietQR";
    res.status(200).json({
      status: "success",
      message: `Đã xác nhận thu cọc ${roundMoney(reservation.depositAmount).toLocaleString("vi-VN")}đ (${methodName}) thành công!`,
      data: { reservation },
    });
  } catch (error) {
    next(error);
  }
};

// 4. Giả lập nộp cọc thành công cho Demo Đồ Án
exports.demoConfirmDeposit = async (req, res, next) => {
  try {
    const reservation = await Reservation.findById(req.params.id);
    if (!reservation) return next(new AppError("Không tìm thấy đơn đặt bàn này", 404));

    if (["CANCELLED", "COMPLETED"].includes(reservation.status)) {
      return next(new AppError(`Đơn đặt bàn đang ở trạng thái '${reservation.status}', không thể nộp cọc`, 409));
    }

    reservation.depositStatus = "PAID";
    reservation.depositConfirmedAt = new Date();
    if (reservation.status === "PENDING") {
      reservation.status = "CONFIRMED";
    }
    await reservation.save();

    emitEvent("reservations:changed");
    notifier.notifyDepositConfirmed(reservation);

    res.status(200).json({
      status: "success",
      message: `[DEMO TEST] Đã giả lập thanh toán nộp cọc ${roundMoney(reservation.depositAmount).toLocaleString("vi-VN")}đ thành công!`,
      data: { reservation },
    });
  } catch (error) {
    next(error);
  }
};

// 5. Nhân viên chủ động đánh dấu đơn là No-Show (Khách không đến nhận bàn)
exports.markNoShow = async (req, res, next) => {
  try {
    const { id } = req.params;
    const { reason } = req.body;

    const reservation = await Reservation.findById(id);
    if (!reservation) return next(new AppError("Không tìm thấy đơn đặt bàn này", 404));

    if (["CANCELLED", "COMPLETED", "ARRIVED"].includes(reservation.status)) {
      return next(new AppError(`Đơn đặt bàn đang ở trạng thái '${reservation.status}', không thể đánh dấu No-Show`, 409));
    }

    reservation.status = "NO_SHOW";
    reservation.tables = [];
    reservation.notes = (reservation.notes ? reservation.notes + " | " : "") + (reason ? reason.trim() : "Nhân viên xác nhận khách vắng mặt (No-Show)");
    await reservation.save();

    emitEvent("reservations:changed");
    emitEvent("tables:changed");
    notifier.notifyReservationNoShow(reservation);
    logAction(req, "MANUAL_NO_SHOW", "Reservation", reservation._id, {
      reservationCode: reservation.reservationCode,
      reason,
    });

    res.status(200).json({
      status: "success",
      message: `Đã đánh dấu đơn đặt bàn ${reservation.reservationCode} là Khách vắng mặt (No-Show)`,
      data: { reservation },
    });
  } catch (error) {
    next(error);
  }
};

// 6. Quét nhanh No-Show theo yêu cầu (Admin on-demand scan)
exports.triggerNoShowScan = async (req, res, next) => {
  try {
    const { scanAndExpireNoShowReservations } = require("../jobs/reservation-cron");
    const result = await scanAndExpireNoShowReservations();

    res.status(200).json({
      status: "success",
      message: `Đã hoàn tất quét No-Show. Tổng số đơn quá hạn chuyển sang No-Show: ${result.count}`,
      data: result,
    });
  } catch (error) {
    next(error);
  }
};

// 7. Quản lý DUYỆT yêu cầu dời lịch đặt bàn của khách hàng
exports.approveReschedule = async (req, res, next) => {
  try {
    const reservation = await Reservation.findById(req.params.id);
    if (!reservation) return next(new AppError("Không tìm thấy đơn đặt bàn này", 404));

    if (!reservation.rescheduleRequest || reservation.rescheduleRequest.status !== "PENDING" || !reservation.rescheduleRequest.requestedStartAt) {
      return next(new AppError("Đơn đặt bàn này không có yêu cầu dời lịch đang chờ duyệt", 400));
    }

    const newStartAt = new Date(reservation.rescheduleRequest.requestedStartAt);
    const { getRestaurantPaymentSettings } = require("../utils/reservation-policy");
    const settings = await getRestaurantPaymentSettings();
    const endTime = new Date(newStartAt.getTime() + settings.durationMinutes * 60000);

    const occupiedTableIds = await tableEngine.getOccupiedTableIds(newStartAt, endTime);
    const allTables = await Table.find({ isActive: { $ne: false }, status: { $ne: "MAINTENANCE" } });
    const availableTables = allTables.filter((t) => !occupiedTableIds.has(t._id.toString()));

    const singleMatches = availableTables
      .filter((t) => t.capacity >= reservation.guestsCount)
      .sort((a, b) => a.capacity - b.capacity);

    let assignedTables = [];
    if (singleMatches.length > 0) {
      assignedTables = [singleMatches[0]._id];
    } else {
      const combinations = await tableEngine.findCombinations(availableTables, reservation.guestsCount);
      combinations.sort((a, b) => a.totalCapacity - b.totalCapacity);
      if (combinations.length > 0) assignedTables = combinations[0].tables.map((t) => t._id);
    }

    if (assignedTables.length === 0) {
      return next(new AppError("Không còn bàn trống trong khung giờ mới khách yêu cầu. Vui lòng liên hệ trực tiếp với khách hoặc từ chối.", 409));
    }

    reservation.startAt = newStartAt;
    reservation.endAt = endTime;
    reservation.tables = assignedTables;
    reservation.status = "CONFIRMED";
    reservation.rescheduleRequest.status = "APPROVED";
    reservation.rescheduleRequest.processedBy = req.user._id;
    reservation.rescheduleRequest.processedAt = new Date();

    await reservation.save();

    emitEvent("reservations:changed");
    emitEvent("tables:changed");
    notifier.notifyReservationCreated(reservation);
    logAction(req, "APPROVE_RESCHEDULE", "Reservation", reservation._id, {
      reservationCode: reservation.reservationCode,
      newStartAt,
      assignedTables,
    });

    const populated = await Reservation.findById(reservation._id)
      .populate("tables", "tableNumber capacity area")
      .populate("preOrderDishes.dish", "name price");

    res.status(200).json({
      status: "success",
      message: `Đã duyệt dời lịch thành công cho đơn ${reservation.reservationCode}`,
      data: { reservation: populated },
    });
  } catch (error) {
    next(error);
  }
};

// 8. Quản lý TỪ CHỐI yêu cầu dời lịch đặt bàn
exports.rejectReschedule = async (req, res, next) => {
  try {
    const { reason } = req.body;
    const reservation = await Reservation.findById(req.params.id);
    if (!reservation) return next(new AppError("Không tìm thấy đơn đặt bàn này", 404));

    if (!reservation.rescheduleRequest || reservation.rescheduleRequest.status !== "PENDING") {
      return next(new AppError("Đơn đặt bàn này không có yêu cầu dời lịch đang chờ duyệt", 400));
    }

    reservation.rescheduleRequest.status = "REJECTED";
    reservation.rescheduleRequest.reason = reason || "Nhà hàng kín bàn trong khung giờ này";
    reservation.rescheduleRequest.processedBy = req.user._id;
    reservation.rescheduleRequest.processedAt = new Date();

    await reservation.save();

    emitEvent("reservations:changed");
    logAction(req, "REJECT_RESCHEDULE", "Reservation", reservation._id, {
      reservationCode: reservation.reservationCode,
      reason,
    });

    res.status(200).json({
      status: "success",
      message: `Đã từ chối yêu cầu dời lịch của đơn ${reservation.reservationCode}`,
      data: { reservation },
    });
  } catch (error) {
    next(error);
  }
};

// 9. Quản lý kiểm tra bàn trống & xung đột theo thời gian thực (Check Availability)
exports.checkTableAvailability = async (req, res, next) => {
  try {
    const { startAt, guestsCount = 2, excludeReservationId } = req.query;
    if (!startAt) {
      return next(new AppError("Vui lòng cung cấp thời gian cần kiểm tra bàn trống", 400));
    }

    const startTime = new Date(startAt);
    if (Number.isNaN(startTime.getTime())) {
      return next(new AppError("Thời gian kiểm tra không hợp lệ", 400));
    }

    const { getRestaurantPaymentSettings } = require("../utils/reservation-policy");
    const settings = await getRestaurantPaymentSettings();
    const duration = settings.durationMinutes || 120;
    const endTime = new Date(startTime.getTime() + duration * 60000);

    const occupiedSet = await tableEngine.getOccupiedTableIds(startTime, endTime, excludeReservationId);

    const allTables = await Table.find({
      isActive: { $ne: false },
      status: { $ne: "MAINTENANCE" },
    }).populate("area", "name");

    const guests = parseInt(guestsCount, 10) || 2;

    const availableTables = [];
    const occupiedTables = [];

    for (const table of allTables) {
      const isOccupied = occupiedSet.has(table._id.toString());
      if (isOccupied) {
        occupiedTables.push(table);
      } else {
        availableTables.push(table);
      }
    }

    // Gợi ý bàn đơn phù hợp
    const singleMatches = availableTables
      .filter((t) => t.capacity >= guests)
      .sort((a, b) => a.capacity - b.capacity);

    // Gợi ý ghép bàn nếu khách đông
    let combinations = [];
    if (singleMatches.length === 0 || guests >= 6) {
      combinations = await tableEngine.findCombinations(availableTables, guests);
      combinations.sort((a, b) => a.totalCapacity - b.totalCapacity);
    }

    res.status(200).json({
      status: "success",
      data: {
        startTime,
        endTime,
        guestsCount: guests,
        totalTables: allTables.length,
        availableTables,
        occupiedTables,
        occupiedTableIds: Array.from(occupiedSet),
        singleMatches,
        combinations,
      },
    });
  } catch (error) {
    next(error);
  }
};

// 10. Quản lý DỜI LỊCH đặt bàn trực tiếp (Admin Reschedule với kiểm tra xung đột)
exports.adminRescheduleReservation = async (req, res, next) => {
  try {
    const { id } = req.params;
    const { startAt, tableIds, reason } = req.body;

    const reservation = await Reservation.findById(id);
    if (!reservation) return next(new AppError("Không tìm thấy đơn đặt bàn này", 404));

    if (["CANCELLED", "COMPLETED", "ARRIVED"].includes(reservation.status)) {
      return next(new AppError(`Đơn đặt bàn đang ở trạng thái '${reservation.status}', không thể dời lịch`, 409));
    }

    if (!startAt) return next(new AppError("Vui lòng chọn thời gian dùng bữa mới", 400));
    const newStartAt = new Date(startAt);
    if (Number.isNaN(newStartAt.getTime())) {
      return next(new AppError("Thời gian dời lịch không hợp lệ", 400));
    }

    const { getRestaurantPaymentSettings } = require("../utils/reservation-policy");
    const settings = await getRestaurantPaymentSettings();
    const duration = settings.durationMinutes || 120;
    const newEndAt = new Date(newStartAt.getTime() + duration * 60000);

    let assignedTables = [];
    if (Array.isArray(tableIds) && tableIds.length > 0) {
      // Kiểm tra xung đột cho danh sách bàn chỉ định
      const occupiedSet = await tableEngine.getOccupiedTableIds(newStartAt, newEndAt, reservation._id);
      for (const tableId of tableIds) {
        if (occupiedSet.has(tableId.toString())) {
          const conflictTable = await Table.findById(tableId);
          return next(
            new AppError(
              `Bàn ${conflictTable ? conflictTable.tableNumber : tableId} đã có khách sử dụng hoặc đặt trước trong khung giờ này. Vui lòng chọn bàn khác!`,
              409
            )
          );
        }
      }

      if (tableIds.length > 1) {
        const mergeCheck = await tableEngine.validateMergeableTables(tableIds);
        if (!mergeCheck.isValid) {
          return next(
            new AppError(
              "Các bàn chọn ghép không nằm cạnh nhau hoặc không cùng khu vực. Vui lòng chọn bàn kề nhau!",
              400
            )
          );
        }
      }

      assignedTables = tableIds;
    } else {
      // Tự động tìm bàn trống phù hợp
      const occupiedSet = await tableEngine.getOccupiedTableIds(newStartAt, newEndAt, reservation._id);
      const allTables = await Table.find({ isActive: { $ne: false }, status: { $ne: "MAINTENANCE" } });
      const availableTables = allTables.filter((t) => !occupiedSet.has(t._id.toString()));

      const singleMatches = availableTables
        .filter((t) => t.capacity >= reservation.guestsCount)
        .sort((a, b) => a.capacity - b.capacity);

      if (singleMatches.length > 0) {
        assignedTables = [singleMatches[0]._id];
      } else {
        const combinations = await tableEngine.findCombinations(availableTables, reservation.guestsCount);
        combinations.sort((a, b) => a.totalCapacity - b.totalCapacity);
        if (combinations.length > 0) {
          assignedTables = combinations[0].tables.map((t) => t._id);
        }
      }

      if (assignedTables.length === 0) {
        return next(
          new AppError(
            "Không còn bàn trống phù hợp trong khung giờ mới này. Vui lòng chọn khung giờ khác!",
            409
          )
        );
      }
    }

    const oldStartAt = reservation.startAt;
    reservation.startAt = newStartAt;
    reservation.endAt = newEndAt;
    reservation.tables = assignedTables;
    reservation.status = "CONFIRMED";

    if (reservation.rescheduleRequest && reservation.rescheduleRequest.status === "PENDING") {
      reservation.rescheduleRequest.status = "APPROVED";
      reservation.rescheduleRequest.processedBy = req.user ? req.user._id : null;
      reservation.rescheduleRequest.processedAt = new Date();
    }

    const noteLog = `[Quản lý dời lịch sang ${newStartAt.toLocaleString('vi-VN')}${reason ? ' - Lý do: ' + reason : ''}]`;
    reservation.notes = reservation.notes ? `${reservation.notes} | ${noteLog}` : noteLog;

    await reservation.save();

    emitEvent("reservations:changed");
    emitEvent("tables:changed");
    notifier.notifyReservationCreated(reservation);
    logAction(req, "ADMIN_RESCHEDULE", "Reservation", reservation._id, {
      reservationCode: reservation.reservationCode,
      oldStartAt,
      newStartAt,
      assignedTables,
      reason,
    });

    const populated = await Reservation.findById(reservation._id)
      .populate("tables", "tableNumber capacity area")
      .populate("preOrderDishes.dish", "name price");

    res.status(200).json({
      status: "success",
      message: `Đã dời lịch đơn đặt bàn ${reservation.reservationCode} sang ${newStartAt.toLocaleString('vi-VN')} thành công!`,
      data: { reservation: populated },
    });
  } catch (error) {
    next(error);
  }
};

// 11. Quản lý TỰ TẠO ĐƠN ĐẶT BÀN (Hotline / Khách gọi điện / Walk-in)
exports.adminCreateReservation = async (req, res, next) => {
  try {
    const {
      customerName,
      customerPhone,
      customerEmail,
      guestsCount,
      startAt,
      type = "NORMAL",
      tableIds,
      depositAmount = 0,
      depositStatus = "NONE",
      depositMethod = "CASH",
      notes,
    } = req.body;

    if (!customerName || !customerPhone || !guestsCount || !startAt) {
      return next(new AppError("Vui lòng điền đầy đủ Tên, Số điện thoại, Số khách và Thời gian đặt bàn", 400));
    }

    const guests = parseInt(guestsCount, 10);
    if (isNaN(guests) || guests <= 0) {
      return next(new AppError("Số lượng khách phải là số nguyên dương", 400));
    }

    const startTime = new Date(startAt);
    if (Number.isNaN(startTime.getTime())) {
      return next(new AppError("Thời gian dùng bữa không hợp lệ", 400));
    }

    const { getRestaurantPaymentSettings } = require("../utils/reservation-policy");
    const settings = await getRestaurantPaymentSettings();
    const duration = settings.durationMinutes || 120;
    const endTime = new Date(startTime.getTime() + duration * 60000);

    const occupiedSet = await tableEngine.getOccupiedTableIds(startTime, endTime);

    let assignedTables = [];
    let isCombined = false;

    if (Array.isArray(tableIds) && tableIds.length > 0) {
      for (const tableId of tableIds) {
        if (occupiedSet.has(tableId.toString())) {
          const conflictTable = await Table.findById(tableId);
          return next(
            new AppError(
              `Bàn ${conflictTable ? conflictTable.tableNumber : tableId} đã có khách trong khung giờ này. Vui lòng chọn bàn khác!`,
              409
            )
          );
        }
      }

      if (tableIds.length > 1) {
        const mergeCheck = await tableEngine.validateMergeableTables(tableIds);
        if (!mergeCheck.isValid) {
          return next(new AppError("Các bàn được chọn không nằm kề nhau để ghép. Vui lòng chọn bàn liền kề!", 400));
        }
        isCombined = true;
      }
      assignedTables = tableIds;
    } else {
      // Auto-assign table(s)
      const allTables = await Table.find({ isActive: { $ne: false }, status: { $ne: "MAINTENANCE" } });
      const availableTables = allTables.filter((t) => !occupiedSet.has(t._id.toString()));

      const singleMatches = availableTables
        .filter((t) => t.capacity >= guests)
        .sort((a, b) => a.capacity - b.capacity);

      if (singleMatches.length > 0) {
        assignedTables = [singleMatches[0]._id];
      } else {
        const combinations = await tableEngine.findCombinations(availableTables, guests);
        combinations.sort((a, b) => a.totalCapacity - b.totalCapacity);
        if (combinations.length > 0) {
          assignedTables = combinations[0].tables.map((t) => t._id);
          isCombined = true;
        }
      }

      if (assignedTables.length === 0) {
        return next(
          new AppError(
            "Không tìm thấy bàn trống phù hợp cho số lượng khách trong khung giờ này. Vui lòng chọn khung giờ khác!",
            409
          )
        );
      }
    }

    const { generateUniqueCode } = require("../utils/code-generator");
    const reservationCode = await generateUniqueCode(Reservation, "RES", "reservationCode");

    const finalDepositAmount = Number(depositAmount) || 0;
    const finalDepositStatus = finalDepositAmount > 0 ? (depositStatus || "UNPAID") : "NONE";

    const newReservation = await Reservation.create({
      reservationCode,
      customerName: customerName.trim(),
      customerPhone: customerPhone.trim(),
      customerEmail: customerEmail ? customerEmail.trim() : undefined,
      guestsCount: guests,
      startAt: startTime,
      endAt: endTime,
      type: type || "NORMAL",
      status: "CONFIRMED",
      tables: assignedTables,
      isCombined,
      depositAmount: finalDepositAmount,
      depositStatus: finalDepositStatus,
      depositMethod: finalDepositStatus === "PAID" ? depositMethod : undefined,
      depositConfirmedAt: finalDepositStatus === "PAID" ? new Date() : undefined,
      depositConfirmedBy: finalDepositStatus === "PAID" && req.user ? req.user._id : undefined,
      notes: notes ? notes.trim() : "Khách đặt bàn qua Hotline nhà hàng",
    });

    emitEvent("reservations:changed");
    emitEvent("tables:changed");
    notifier.notifyReservationCreated(newReservation);
    logAction(req, "ADMIN_CREATE_RESERVATION", "Reservation", newReservation._id, {
      reservationCode: newReservation.reservationCode,
      customerName: newReservation.customerName,
      customerPhone: newReservation.customerPhone,
      startAt: newReservation.startAt,
      tables: assignedTables,
    });

    const populated = await Reservation.findById(newReservation._id)
      .populate("tables", "tableNumber capacity area");

    res.status(201).json({
      status: "success",
      message: `Tạo đơn đặt bàn ${reservationCode} thành công!`,
      data: { reservation: populated },
    });
  } catch (error) {
    next(error);
  }
};

// 12. Quản lý HỦY ĐƠN ĐẶT BÀN (Admin Cancel kèm lý do)
exports.adminCancelReservation = async (req, res, next) => {
  try {
    const { id } = req.params;
    const { reason } = req.body;

    const reservation = await Reservation.findById(id);
    if (!reservation) return next(new AppError("Không tìm thấy đơn đặt bàn này", 404));

    if (["CANCELLED", "COMPLETED"].includes(reservation.status)) {
      return next(new AppError(`Đơn đặt bàn đang ở trạng thái '${reservation.status}', không thể hủy`, 409));
    }

    reservation.status = "CANCELLED";
    reservation.cancellationReason = reason ? reason.trim() : "Quản lý hủy theo yêu cầu của khách qua hotline";
    reservation.tables = [];

    const RestaurantSetting = require("../models/setting.model");
    const settings = await RestaurantSetting.findOne();
    const { calculateRefundAmount } = require("../utils/reservation-policy");
    reservation.refundAmount = calculateRefundAmount(reservation, settings?.refund);
    reservation.refundStatus = reservation.refundAmount > 0 ? "PENDING" : "NONE";

    await reservation.save();

    emitEvent("reservations:changed");
    emitEvent("tables:changed");
    notifier.notifyReservationCancelled(reservation);
    logAction(req, "ADMIN_CANCEL_RESERVATION", "Reservation", reservation._id, {
      reservationCode: reservation.reservationCode,
      reason: reservation.cancellationReason,
      refundAmount: reservation.refundAmount,
    });

    res.status(200).json({
      status: "success",
      message: `Đã hủy đơn đặt bàn ${reservation.reservationCode} thành công!`,
      data: { reservation },
    });
  } catch (error) {
    next(error);
  }
};

