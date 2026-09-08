const Dish = require("../models/dish.model");
const Category = require("../models/category.model");
const RestaurantSetting = require("../models/setting.model");
const Table = require("../models/table.model");
const Area = require("../models/area.model");

/**
 * Service RAG: Chuyên trách truy xuất và định dạng tri thức thời gian thực từ Database
 */
class RagService {
  /**
   * Truy xuất toàn bộ thực đơn đang bán và nhóm theo vùng miền/danh mục
   */
  async getMenuKnowledge() {
    try {
      const dishes = await Dish.find({ availability: true })
        .populate("category", "name")
        .lean();

      const dishesByRegion = { Bắc: [], Trung: [], Nam: [], Khác: [] };
      const dishDictionary = [];

      dishes.forEach((d) => {
        const itemInfo = {
          id: d._id.toString(),
          name: d.name,
          category: d.category?.name || "Món chính",
          price: d.price,
          region: d.region || "Chung",
          description: d.description || "",
        };

        if (dishesByRegion[d.region]) {
          dishesByRegion[d.region].push(itemInfo);
        } else {
          dishesByRegion["Khác"].push(itemInfo);
        }

        dishDictionary.push(itemInfo);
      });

      return {
        totalDishes: dishes.length,
        dishesByRegion,
        dishDictionary,
      };
    } catch (error) {
      console.error("[RAG Service] Error retrieving menu:", error);
      return { totalDishes: 0, dishesByRegion: {}, dishDictionary: [] };
    }
  }

  /**
   * Truy xuất quy định và thông số vận hành của nhà hàng
   */
  async getRestaurantPolicies() {
    try {
      const settings = await RestaurantSetting.findOne().lean();
      const areas = await Area.find({ isActive: { $ne: false } }).lean();

      return {
        restaurantName: "Nhà Hàng 3 Miền Cua",
        specialty: "Hải sản tươi sống và ẩm thực 3 miền Bắc - Trung - Nam, đặc biệt là các món Cua Cà Mau và Lẩu đặc sản",
        openingHours: "10:00 - 23:00 hàng ngày",
        durationMinutes: settings?.reservation?.defaultDurationMinutes || 120,
        defaultDepositAmount: settings?.reservation?.defaultDepositAmount || 100000,
        depositPolicy: "Bắt buộc cọc 50% tiền món nếu có đặt trước món ăn (Pre-order), hoặc cọc 100.000đ với đoàn từ 4 khách trở lên.",
        tableMergePolicy: "Hệ thống tự động sử dụng thuật toán Graph BFS để ghép cụm bàn kề nhau trong cùng khu vực cho đoàn đông (8 đến 20 khách).",
        availableAreas: areas.map((a) => a.name).join(", "),
      };
    } catch (error) {
      console.error("[RAG Service] Error retrieving policies:", error);
      return {
        restaurantName: "Nhà Hàng 3 Miền Cua",
        openingHours: "10:00 - 23:00",
        depositPolicy: "Cọc 50% tiền món nếu có pre-order hoặc 100k cho đoàn >= 4 người.",
      };
    }
  }

  /**
   * Xây dựng ngữ cảnh RAG (Context) hoàn chỉnh truyền vào Prompt của LLM
   */
  async buildRAGContext(userQuery) {
    const [menuData, policies] = await Promise.all([
      this.getMenuKnowledge(),
      this.getRestaurantPolicies(),
    ]);

    let menuSummary = "DANH SÁCH THỰC ĐƠN NHÀ HÀNG 3 MIỀN CUA:\n";
    for (const [region, items] of Object.entries(menuData.dishesByRegion)) {
      if (items.length > 0) {
        menuSummary += `\n[Đặc sản Miền ${region}]:\n`;
        items.forEach((it) => {
          menuSummary += `- ${it.name} | Danh mục: ${it.category} | Giá: ${it.price.toLocaleString("vi-VN")}đ | Ghi chú: ${it.description || "Ngon, đậm vị"}\n`;
        });
      }
    }

    const policySummary = `
CHÍNH SÁCH & THÔNG TIN NHÀ HÀNG:
- Tên quán: ${policies.restaurantName} (${policies.specialty})
- Giờ phục vụ: ${policies.openingHours}
- Các khu vực bàn: ${policies.availableAreas || "Tầng 1, Tầng 2, Sân vườn, VIP"}
- Chính sách đặt cọc: ${policies.depositPolicy}
- Chính sách ghép bàn: ${policies.tableMergePolicy}
`;

    return {
      ragContextText: `${policySummary}\n${menuSummary}`,
      dishDictionary: menuData.dishDictionary,
      policies,
    };
  }
}

module.exports = new RagService();
