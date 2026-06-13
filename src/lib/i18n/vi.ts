// Vietnamese UI strings (i18n.svelte.ts). Any key missing here falls back to English, so this can
// grow incrementally. Keep placeholders ({n}, {name}, {label}, {size}, {count}, {total}, {word}).

import type { Dict } from './i18n.svelte';

export const vi: Dict = {
  // ── Topbar ───────────────────────────────────────────────────────────────
  'topbar.search': 'Tìm hoặc hỏi ghi chú của bạn…',
  'topbar.model': 'Mô hình',
  'topbar.modelTip': 'Trợ lý AI chạy trên máy bạn',
  'topbar.modelLoadingTip': 'Mô hình đang tải — vui lòng đợi tải xong rồi mới đổi',
  'topbar.reading': 'Đang đọc ghi chú…',
  'topbar.readingTip': 'Đang chuẩn bị ghi chú để tìm kiếm',
  'topbar.connecting': 'Đang kết nối ghi chú…',
  'topbar.connectingTip': 'Ghi chú đã tìm được; đang liên kết các ghi chú liên quan ở chế độ nền',
  'topbar.ready': 'Sẵn sàng',
  'topbar.readyTip': 'Ghi chú của bạn đã sẵn sàng để tìm kiếm',
  'topbar.slower': 'Chế độ chậm',
  'topbar.slowerTip':
    'Máy này đang chạy Nebula ở chế độ chậm hơn. Để nhanh nhất, dùng Chrome hoặc Edge và bật tăng tốc phần cứng.',
  'topbar.tour': 'Xem hướng dẫn nhanh',
  'topbar.github': 'Xem mã nguồn trên GitHub',
  'topbar.export': 'Xuất kho ghi chú',
  'topbar.reset': 'Đặt lại toàn bộ dữ liệu — khôi phục khi mô hình bị treo hoặc ghi chú lỗi',
  'topbar.advancedOn': 'Chế độ nâng cao đang bật — hiện thông số kỹ thuật',
  'topbar.advancedOff': 'Chế độ nâng cao — hiện thông số kỹ thuật',
  'topbar.theme': 'Đổi giao diện sáng/tối',
  'topbar.language': 'Ngôn ngữ',

  // ── Model banner ─────────────────────────────────────────────────────────
  'banner.loading': 'Đang chuẩn bị trợ lý',
  'banner.searchNow': 'Bạn đã có thể tìm ghi chú ngay — không phải chờ',

  // ── Sidebar ──────────────────────────────────────────────────────────────
  'side.vault': 'Kho ghi chú',
  'side.newNote': 'Ghi chú / thư mục mới',
  'side.entities': 'Người, nơi chốn & chủ đề',
  'side.connect': 'Kết nối ghi chú',
  'side.connecting': 'đang kết nối…',
  'side.seeConnections': 'Xem kết nối',
  'side.updateConnections': 'Cập nhật kết nối — còn ghi chú mới',
  'side.updateConnectionsTip': 'Ghi chú mới chưa được kết nối — cập nhật để gộp vào',
  'side.showAll': 'Xem tất cả {n}',
  'side.showFewer': 'Thu gọn',
  'side.tags': 'Thẻ',
  'side.clear': 'xóa',
  'side.searchIn': 'Tìm trong',
  'side.allNotes': 'tất cả ghi chú',
  'side.searchInTip': 'Giới hạn câu hỏi và chia sẻ trong một thư mục hoặc thẻ',

  // ── Ask rail ─────────────────────────────────────────────────────────────
  'ask.title': 'Hỏi',
  'ask.searching': 'đang tìm trong',
  'ask.scopeAll': 'tất cả ghi chú',
  'ask.new': 'Mới',
  'ask.newTip': 'Bắt đầu cuộc trò chuyện mới',
  'ask.idle':
    'Hỏi bất cứ điều gì về ghi chú của bạn. Câu trả lời chỉ lấy từ những gì bạn đã viết, và dẫn ngược về nơi tìm thấy mỗi thông tin.',
  'ask.try': 'Thử hỏi',
  'ask.try1': 'Chúng ta đã quyết định gì và vì sao?',
  'ask.try2': 'Ai phụ trách gì — và chúng liên kết ra sao?',
  'ask.try3': 'Tóm tắt các rủi ro còn mở',
  'ask.thinking': 'Đang suy nghĩ…',
  'ask.thoughts': 'Suy luận',
  'ask.used': 'dùng {count}/{total}',
  'ask.sources': 'Nguồn',
  'ask.match': 'khớp',
  'ask.vector': 'vector',
  'ask.howFound': 'Cách tìm ra câu trả lời này',
  'ask.subgraph': 'Đồ thị truy hồi con',
  'ask.share': 'Chia sẻ với AI khác',
  'ask.placeholder': 'Đặt câu hỏi về ghi chú của bạn…',
  'ask.send': 'Hỏi',
  'ask.runsLocal': 'Chạy trên máy bạn',
  'ask.noResults': 'Tôi không tìm thấy gì về điều đó trong ghi chú của bạn.',
  'ask.emptyAnswer':
    'Tôi tìm thấy ghi chú liên quan nhưng lần này chưa soạn được câu trả lời — xem các nguồn bên dưới, hoặc thử diễn đạt lại câu hỏi.',

  'mode.reason': 'Suy luận giúp tôi',
  'mode.reasonAdv': 'Suy luận',
  'mode.reasonTip': 'Để trợ lý suy luận trên ghi chú của bạn và đưa lời khuyên',
  'mode.grounded': 'Chỉ trích ghi chú',
  'mode.groundedAdv': 'Bám ghi chú',
  'mode.groundedTip': 'Bám sát đúng những gì ghi chú của bạn ghi',
  'mode.graph': 'Kết nối ý',
  'mode.graphAdv': 'GraphRAG',
  'mode.graphTip': 'Kéo thêm các ghi chú liên quan có chung người, nơi chốn hoặc chủ đề',

  // ── Graph lens ───────────────────────────────────────────────────────────
  'lens.connections': 'Kết nối',
  'lens.graphLens': 'Đồ thị tri thức',
  'lens.topics': 'chủ đề',
  'lens.entities': 'thực thể',
  'lens.links': 'liên kết',
  'lens.relations': 'quan hệ',
  'lens.ready': 'sẵn sàng',
  'lens.close': 'Đóng',
  'lens.pickOne': 'Chọn một mục để xem nó kết nối thế nào trong các ghi chú của bạn.',
  'lens.mentions': 'Ghi chú nhắc đến {name}',
  'lens.nothing': 'Chưa có gì kết nối với {name}.',
  'lens.retry': '↻ Thử kết nối lại',
  'lens.hint': 'Bấm vào nút bất kỳ để căn giữa · kéo để di chuyển · cuộn để phóng to',
  'lens.extracting': 'Đang trích xuất thực thể & quan hệ…',

  // ── Model gate ───────────────────────────────────────────────────────────
  'gate.title': 'Trợ lý AI riêng tư của bạn',
  'gate.desc':
    'Chạy hoàn toàn trên máy bạn — tải về một lần, sau đó dùng ngoại tuyến. Không cần tài khoản, và không gì rời khỏi thiết bị của bạn.',
  'gate.recommended': '★ Khuyến nghị — {label}',
  'gate.bestFit': 'phù hợp nhất với máy bạn · {size}',
  'gate.cached': '✓ sẵn sàng',
  'gate.multilingual': 'đa ngôn ngữ',
  'gate.removeTip': 'Gỡ khỏi trình duyệt này',
  'gate.skip': 'Bỏ qua — vẫn tìm kiếm và ghi chú được',
  'gate.noWebgpu':
    '⚠ Máy này không chạy được trợ lý AI, nhưng tìm kiếm và viết ghi chú vẫn hoạt động đầy đủ. Để dùng trợ lý, hãy thử Chrome hoặc Edge trên máy có card đồ họa.',
  'gate.continue': 'Tiếp tục',
  'gate.brokenHint': 'Có gì đó hỏng — mô hình treo hay ghi chú không mở được?',
  'gate.resetLink': 'Đặt lại toàn bộ dữ liệu…',

  // ── Reset dialog ─────────────────────────────────────────────────────────
  'reset.title': '⚠ Đặt lại toàn bộ dữ liệu?',
  'reset.lead': 'Thao tác này xóa vĩnh viễn mọi thứ Nebula lưu trên máy này và không thể hoàn tác:',
  'reset.item.notes': 'Toàn bộ ghi chú — chúng chỉ tồn tại ở đây, không phải file',
  'reset.item.index': 'chỉ mục tìm kiếm & đồ thị tri thức',
  'reset.item.models': 'các mô hình AI đã tải (lần sau sẽ phải tải lại)',
  'reset.item.settings': 'cài đặt, giao diện và trạng thái hướng dẫn',
  'reset.tip': 'Muốn giữ ghi chú?',
  'reset.exportFirst': 'Xuất kho ghi chú trước',
  'reset.thenBack': '— rồi quay lại.',
  'reset.typeToConfirm': 'Gõ {word} để xác nhận:',
  'reset.cancel': 'Hủy',
  'reset.erase': 'Xóa tất cả',
  'reset.erasing': 'Đang xóa…',

  // ── Guided tour (coach-marks) ────────────────────────────────────────────
  'tour.welcome.title': '👋 Chào mừng đến với Nebula',
  'tour.welcome.body':
    'Nebula biến ghi chú của bạn thành thứ bạn có thể đặt câu hỏi — và mọi thứ chạy ngay trên máy bạn. Không gì được tải lên mạng. Đây là bốn điều đáng biết.',
  'tour.ask.title': 'Hỏi ghi chú của bạn bất cứ điều gì',
  'tour.ask.body':
    'Gõ câu hỏi vào đây — ví dụ “Maya, Leo và Priya mỗi người muốn làm gì ở Nhật?” — Nebula trả lời dựa trên chính ghi chú của bạn, kèm liên kết về nơi tìm thấy mỗi thông tin. Nhấn ⌘J để nhảy tới đây bất cứ lúc nào.',
  'tour.modes.title': 'Hai cách trả lời',
  'tour.modes.body':
    '“Chỉ trích ghi chú” bám sát đúng những gì bạn viết. “Suy luận giúp tôi” cho phép trợ lý suy luận và đưa lời khuyên. Chọn cách phù hợp với câu hỏi của bạn.',
  'tour.graph.title': 'Xem ghi chú của bạn kết nối thế nào',
  'tour.graph.body':
    'Nebula tự động liên kết các ghi chú có chung người, nơi chốn và chủ đề — kể cả khi chúng không chung từ nào. Mở một mục để xem mọi thứ liên quan đến nó.',
  'tour.new.title': 'Biến nó thành của riêng bạn',
  'tour.new.body':
    'Thêm ghi chú của bạn bằng nút +, hoặc chỉ cần kéo thả một file PDF hay bảng tính — nó cũng sẽ tìm kiếm được. Khi sẵn sàng, bạn có thể xóa các ghi chú ví dụ.',
  'tour.done.title': '✨ Bạn đã sẵn sàng',
  'tour.done.body':
    'Thử đặt một câu hỏi ở khung bên phải. Bạn có thể xem lại hướng dẫn này bất cứ lúc nào từ nút “?” phía trên.',
  'tour.step': 'Bước {n}/{total}',
  'tour.skip': 'Bỏ qua',
  'tour.back': 'Quay lại',
  'tour.next': 'Tiếp',
  'tour.done': 'Xong',

  // ── Note view / editor ───────────────────────────────────────────────────
  'note.edit': 'Sửa',
  'note.newNote': 'Ghi chú mới',
  'note.title': 'Tiêu đề ghi chú',
  'note.folder': 'thư mục — để trống = gốc kho',
  'note.body': 'Viết bằng Markdown… gõ [[ để liên kết ghi chú',
  'note.empty': 'Chọn một ghi chú từ thanh bên, hoặc',
  'note.writeNew': 'viết ghi chú mới',
  'note.emptyHint':
    'Bấm chuột phải vào cây thư mục để thêm · đổi tên · di chuyển · xóa. Kéo một ghi chú vào thư mục để chuyển.',
  'note.today': 'Hôm nay',
  'note.import': 'Nhập tệp'
};
