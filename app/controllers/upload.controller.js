const path = require("path");
const fs = require("fs");
const multer = require("multer");
const AppError = require("../app-error");
const config = require("../config");

// Cấu hình lưu trữ file bằng Multer vào thư mục uploads/dishes
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const uploadDir = path.join(__dirname, "../../public/uploads/dishes");
    if (!fs.existsSync(uploadDir)) {
      fs.mkdirSync(uploadDir, { recursive: true });
    }
    cb(null, uploadDir);
  },
  filename: (req, file, cb) => {
    const slugify = require("../utils/slugify");
    const ext = path.extname(file.originalname).toLowerCase();
    
    // Ưu tiên lấy tên hoặc slug từ query / body để đặt tên file đẹp chuẩn SEO
    const rawName = req.query.slug || req.query.name || (req.body && (req.body.slug || req.body.name));
    const baseSlug = rawName ? slugify(rawName) : "img";
    const uniqueSuffix = Date.now() + "-" + Math.round(Math.random() * 1e4);
    
    cb(null, `${baseSlug}-${uniqueSuffix}${ext}`);
  },
});

// Lọc định dạng file ảnh (kiểm tra cả MIME lẫn phần mở rộng)
const allowedExtensions = [".jpg", ".jpeg", ".png", ".webp", ".gif"];
const fileFilter = (req, file, cb) => {
  const ext = path.extname(file.originalname).toLowerCase();
  if (file.mimetype.startsWith("image/") && allowedExtensions.includes(ext)) {
    cb(null, true);
  } else {
    cb(new AppError("Chỉ chấp nhận file hình ảnh (jpg, jpeg, png, webp, gif)!", 400), false);
  }
};

const upload = multer({
  storage,
  fileFilter,
  limits: { fileSize: 5 * 1024 * 1024 }, // Tối đa 5MB
});

exports.uploadSingle = upload.single("image");

exports.uploadResponse = (req, res, next) => {
  if (!req.file) {
    return next(new AppError("Vui lòng chọn 1 file hình ảnh để tải lên", 400));
  }

  // Tự động sao chép sang frontend/public/uploads/dishes để Vite dev server nhận diện ngay lập tức
  try {
    const frontendDir = path.join(__dirname, "../../../frontend/public/uploads/dishes");
    if (!fs.existsSync(frontendDir)) {
      fs.mkdirSync(frontendDir, { recursive: true });
    }
    fs.copyFileSync(req.file.path, path.join(frontendDir, req.file.filename));
  } catch (err) {
    console.warn("Không thể đồng bộ file sang frontend:", err.message);
  }

  const fileUrl = `/uploads/dishes/${req.file.filename}`;

  res.status(200).json({
    status: "success",
    message: "Tải ảnh lên thành công!",
    url: fileUrl,
    filename: req.file.filename,
  });
};
