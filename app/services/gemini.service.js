const { GoogleGenerativeAI } = require("@google/generative-ai");
const config = require("../config");

/**
 * Service AI: Quản lý giao tiếp Google Gemini API với mô hình RAG
 * Kèm cơ chế Graceful Deterministic Fallback khi không có API Key
 */
class GeminiService {
  constructor() {
    this.apiKey = config.geminiApiKey;
    this.modelName = config.geminiModel || "gemini-2.5-flash";
    this.genAI = this.apiKey ? new GoogleGenerativeAI(this.apiKey) : null;
  }

  /**
   * Gọi Gemini API phân tích câu hỏi dựa trên Context RAG
   */
  async generateRAGResponse({ userPrompt, ragContext, currentBookingContext, conversationHistory = [] }) {
    // 1. Kiểm tra nếu có Gemini API Key hợp lệ thì gọi Gemini
    if (this.genAI && this.apiKey && this.apiKey.trim().length > 10) {
      try {
        const model = this.genAI.getGenerativeModel({
          model: this.modelName,
          generationConfig: {
            temperature: 0.3, // Nhiệt độ thấp để phân tích chính xác, không hallucinate
            responseMimeType: "application/json",
          },
          systemInstruction: `Bạn là "Trợ Lý AI 3 Miền Cua" - trợ lý thông minh của Nhà Hàng 3 Miền Cua.
Nhiệm vụ: Tư vấn món ăn, hỗ trợ đặt bàn mới (New Booking) hoặc bổ sung món cho đơn đặt bàn đã có sẵn (Existing Booking).

QUY TẮC PHÂN BIỆT Ý ĐỊNH BẮT BUỘC:
1. NẾU khách nhắc tới đơn đã đặt sẵn (ví dụ: có mã "RES-XXXXXX", "gọi món cho đơn...", "thêm món vào bàn đã đặt", "bổ sung món"):
   - "isBooking": false (TUYỆT ĐỐI KHÔNG ĐƯỢC TẠO ĐƠN ĐẶT BÀN MỚI).
   - "targetReservationCode": "mã đơn nếu có (ví dụ: RES-237295)",
   - "intent": Nếu khách đã nêu tên món -> "ADD_DISH_TO_EXISTING"; nếu khách chưa nêu món -> "MENU_RECOMMENDATION".
2. NẾU khách yêu cầu ĐẶT BÀN MỚI (giữ chỗ, chọn giờ đến, số khách):
   - "isBooking": true,
   - "intent": "BOOKING_PREVIEW".
3. NẾU khách hỏi thực đơn, tư vấn món:
   - "isBooking": false,
   - "intent": "MENU_RECOMMENDATION".

Trả về định dạng JSON DUY NHẤT theo schema sau:
{
  "reply": "Câu trả lời thân thiện, lịch sự, dùng emoji phù hợp, định dạng markdown rõ ràng",
  "intent": "BOOKING_PREVIEW" | "ADD_DISH_TO_EXISTING" | "MENU_RECOMMENDATION" | "GENERAL_HELP",
  "extractedData": {
    "isBooking": false hoặc true,
    "targetReservationCode": "RES-XXXXXX hoặc rỗng",
    "guestsCount": số nguyên,
    "dateOffsetDays": số ngày (0: hôm nay, 1: ngày mai),
    "hours": số giờ (0-23),
    "minutes": số phút,
    "dishes": [
      { "dishName": "Tên món chuẩn trong thực đơn", "quantity": số_lượng }
    ],
    "needTableMerge": true hoặc false
  }
}
`,
        });

        const promptText = `
=== NGỮ CẢNH RAG NHÀ HÀNG THỜI GIAN THỰC ===
${ragContext.ragContextText}

=== NGỮ CẢNH ĐẶT BÀN HIỆN TẠI (NẾU CÓ) ===
${JSON.stringify(currentBookingContext || {}, null, 2)}

=== CÂU NÓI CỦA KHÁCH HÀNG ===
"${userPrompt}"

Hãy phân tích kỹ yêu cầu của khách và trả về JSON chuẩn:
`;

        const result = await model.generateContent(promptText);
        const responseText = result.response.text();
        const parsedJSON = JSON.parse(responseText);

        return {
          source: "GEMINI_RAG",
          ...parsedJSON,
        };
      } catch (geminiError) {
        console.warn("[Gemini Service] Gemini API call failed, falling back to Local NLP Engine:", geminiError.message);
      }
    }

    // 2. Fallback: Bộ xử lý Rule-based NLP nội bộ siêu tốc
    return this.fallbackLocalNLP(userPrompt, ragContext, currentBookingContext);
  }

  /**
   * Fallback: Bộ phân tích Deterministic NLP nội bộ (chạy khi chưa cấu hình Gemini API Key)
   */
  fallbackLocalNLP(prompt, ragContext, currentBookingContext) {
    const text = (prompt || "").trim();
    const resCodeMatch = text.match(/RES-\d+/i);
    const isAddToExisting = !!resCodeMatch || /thêm món|bổ sung món|gọi thêm món|thêm vào bàn|gọi món cho đơn|them mon|bo sung mon/i.test(text);
    const isBooking = !isAddToExisting && /đặt bàn|giữ chỗ|bàn cho|đặt chỗ|đặt 1 bàn|đặt hai bàn|dat ban|giu cho|book|booking|ghép bàn|ghep ban/i.test(text);
    const isMenu = /thực đơn|menu|món ăn|có món gì|đặc sản|thuc don|mon ngon|goi y mon|gợi ý món|tư vấn|món|lẩu|hải sản|thuc don/i.test(text);

    // 1. Phân tích số khách
    let guests = 2;
    const guestMatch = text.match(/(\d+)\s*(người|khách|chỗ|bạn|nguoi|khach|cho)/i);
    if (guestMatch) guests = parseInt(guestMatch[1], 10);
    else {
      const numOnly = text.match(/\b(\d{1,2})\b/);
      if (numOnly) guests = parseInt(numOnly[1], 10);
    }

    // 2. Phân tích ngày giờ
    let dateOffset = 0;
    if (/tối mai|ngày mai|chiều mai|sáng mai|ngay mai/i.test(text)) dateOffset = 1;
    else if (/ngày mốt|ngày kia|ngay mot|ngay kia/i.test(text)) dateOffset = 2;

    let hours = 19;
    let minutes = 0;
    const timeMatch = text.match(/(\d{1,2})\s*(h|gờ|:|gio|giờ)\s*(\d{2})?/i);
    if (timeMatch) {
      hours = parseInt(timeMatch[1], 10);
      if (timeMatch[3]) minutes = parseInt(timeMatch[3], 10);
      if (/tối|đêm|chiều|toi|dem|chieu/i.test(text) && hours < 12) hours += 12;
    } else if (/trưa|trua/i.test(text)) {
      hours = 12;
    }

    // 3. Phân tích món ăn
    const detectedDishes = [];
    const dishDict = ragContext.dishDictionary || [];
    for (const d of dishDict) {
      const cleanName = d.name.toLowerCase();
      const simpleName = cleanName.replace(/(cà mau|bắc bộ|đặc sản|cay nồng|béo ngậy|xiêm|cố đô|ba trái|hải sản cay nồng|bún tươi tẩy)/gi, "").trim();
      if (text.toLowerCase().includes(simpleName) && simpleName.length >= 3) {
        let quantity = 1;
        const qtyMatch = text.match(new RegExp(`(\\d+)\\s*(phần|đĩa|suất|nồi|ly|chai|con|bát|tô|x)?\\s*${simpleName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`, "i"));
        if (qtyMatch && qtyMatch[1]) quantity = parseInt(qtyMatch[1], 10);
        detectedDishes.push({ dishName: d.name, quantity });
      }
    }

    if (isBooking) {
      return {
        source: "LOCAL_NLP_FALLBACK",
        intent: "BOOKING_PREVIEW",
        reply: `🦀 **Em đã tiếp nhận yêu cầu đặt bàn và kiểm tra lịch trống cho Anh/Chị:**`,
        extractedData: {
          isBooking: true,
          guestsCount: guests,
          dateOffsetDays: dateOffset,
          hours,
          minutes,
          dishes: detectedDishes,
          needTableMerge: guests >= 8,
        },
      };
    }

    if (isMenu) {
      return {
        source: "LOCAL_NLP_FALLBACK",
        intent: "MENU_RECOMMENDATION",
        reply: `🦀 **Nhà hàng 3 Miền Cua xin gợi ý các món đặc sản 3 miền hấp dẫn:**`,
        extractedData: {
          isBooking: false,
          dishes: detectedDishes,
        },
      };
    }

    return {
      source: "LOCAL_NLP_FALLBACK",
      intent: "GENERAL_HELP",
      reply: `Dạ em là **Trợ Lý AI 3 Miền Cua**! Em có thể tư vấn món ngon, tự động đặt bàn và ghép bàn đoàn đông giúp Anh/Chị nhé! 🦀`,
      extractedData: {
        isBooking: false,
      },
    };
  }
}

module.exports = new GeminiService();
