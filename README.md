# 🍽️ 3Mien Restaurant - Backend API

Hệ thống Backend RESTful API và Realtime Socket.io phục vụ cho Hệ thống Quản lý và Đặt bàn Nhà hàng 3 Miền.

## 🚀 Công nghệ sử dụng
- **Node.js** & **Express 5**
- **MongoDB** & **Mongoose 9**
- **Socket.io**: Đồng bộ dữ liệu phòng bàn, đơn gọi món thời gian thực
- **Google Generative AI (Gemini)**: Trợ lý AI tư vấn và đặt bàn thông minh (RAG)
- **JWT & Bcryptjs**: Xác thực và phân quyền người dùng
- **ExcelJS**: Xuất báo cáo tài chính doanh thu đa sheet
- **Jest**: Unit & Integration Testing

---

## 🛠️ Hướng dẫn cài đặt và chạy

### 1. Cài đặt Dependencies
```bash
npm install
```

### 2. Cấu hình biến môi trường
Tạo file `.env` dựa trên file `.env.example`:
```bash
cp .env.example .env
```
Điền thông tin kết nối MongoDB và các API key cần thiết trong file `.env`.

### 3. Nạp dữ liệu mẫu (Seed Data)
```bash
# Nạp dữ liệu cơ bản (món ăn, danh mục, bàn, tài khoản mẫu)
npm run seed

# (Tùy chọn) Nạp thêm người dùng và phân quyền
node seed-users-roles.js

# (Tùy chọn) Nạp công thức và định lượng kho
node seed-inventory-recipes.js
```

### 4. Khởi chạy Server
```bash
# Chạy ở môi trường Development (với nodemon tự reload)
npm run dev

# Chạy ở môi trường Production
npm start
```
Mặc định server sẽ lắng nghe tại cổng `http://localhost:3000`.

### 5. Chạy Kiểm thử (Testing)
```bash
npm test
```
