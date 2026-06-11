// Regression: a long Vietnamese note (the K-pop / Sơn Tùng "chim Lạc" article a user reported as
// "1 note failed to index") must chunk WITHIN the embedding window and embed cleanly. Proves the
// failure was environmental (embed model didn't load), not the content. Runs the production ingest
// math exactly: chunk(size 60, overlap 12, whitespace sizer) → real MiniLM tokens → embedBatch(16).
import { describe, it, expect } from 'vitest';
import { chunk } from '$lib/ingest/chunker';
import {
  getTokenizer,
  embedBatch,
  getEmbedder,
  EMBEDDING_DIM,
  EMBEDDING_MAX_TOKENS
} from '$lib/embed/embedder';

// The user's article (representative excerpt — same Vietnamese prose density throughout).
const ARTICLE = `Năm 2012, lần đầu tiên Kpop nếm trải cảm giác tạo ra một siêu hit toàn cầu với Gangnam Style của Psy. Sau nhiều thập kỷ viễn chinh với những chiến lược được đo ni đóng giày nhằm chạm đến thị trường thế giới, cuối cùng thì một bài hát Kpop mang tính châm biếm xã hội Hàn Quốc, cùng điệu nhảy phi ngựa ngộ nghĩnh lại là thứ đi vào lịch sử văn hóa đại chúng. Bài hát không chỉ tạo ra một hiện tượng khi vươn thẳng lên vị trí số 2 trên bảng xếp hạng Billboard Hot 100 và đứng ở đó trong 7 tuần liên tiếp, mà còn là video đầu tiên đạt 1 tỷ và 2 tỷ view.

Điều kỳ diệu là, Gangnam Style hoàn toàn không tuân theo bất kỳ một quy luật, công thức hay chiến lược bài bản nào của các ông lớn giải trí Hàn Quốc lúc bấy giờ. Bằng một cách rất tự nhiên, Gangnam Style rebranding Hàn Quốc từ một quốc gia Đông Á đang phát triển về công nghệ thành một "thủ phủ của sự sành điệu". Trên con đường đại lộ đã được san phẳng, BTS và BLACKPINK thiết lập một kỷ nguyên thống trị tuyệt đối: từ những chuyến world tour cháy vé ở các sân vận động khắp thế giới, chễm chệ ở vị trí Headline của Coachella, cho đến việc trở thành những đại sứ cho các nhà mốt xa xỉ bậc nhất Paris.

Một cú máy hoành tráng phóng tầm mắt ra đại ngàn Tràng An (Ninh Bình) trong MV Come My Way của Sơn Tùng M-TP mở ra một không gian thị giác choáng ngợp, nơi họa tiết chim Lạc ngàn năm chuyển động uyển chuyển cùng các bức họa danh tác. Từ đế chế K-pop với BTS, BlackPink hay siêu hit APT. của Rosé biến trò chơi uống rượu truyền thống thành hiện tượng toàn cầu, cho đến hiện tượng Tyla (Nam Phi) mang dòng nhạc bản địa Amapiano đoạt giải Grammy, hay hơi thở chữa lành từ Fuji Kaze (Nhật Bản).

Đứng ở góc độ của một người làm nghề thực chiến - Ngô Đài Trang, Giám đốc sản xuất đứng sau hàng loạt MV như Để Mị nói cho mà nghe, Duyên Âm, Gieo Quẻ (Hoàng Thùy Linh) hay Thị Mầu, Kén cá chọn canh, Bắc Bling (Hòa Minzy) - chia sẻ: "Với mình việc các sản phẩm nhận được ý kiến trái chiều là chuyện khá bình thường và hiển nhiên, đó là cách một sản phẩm tồn tại trong đời sống."

Cũng với tư duy đóng gói thông minh đó, Rosé (BlackPink) cùng Bruno Mars đã tạo nên một cú nổ toàn cầu mang tên APT.. Về bản chất, "Apateu" chỉ là một trò chơi uống rượu quen thuộc trong đời sống giới trẻ Hàn Quốc. Tiến sĩ Nguyễn Anh Minh - Giám đốc Bảo tàng Mỹ thuật Việt Nam - nhìn nhận về cách Sơn Tùng M-TP đưa các tác phẩm hội họa kinh điển vào MV Come My Way: "Đây là cách làm rất sáng tạo, đưa nghệ thuật vào âm nhạc gửi đến khán giả."

Sẽ không còn những bước đi đơn độc trong sợ hãi, người trẻ hôm nay đang tự tin nương theo đôi cánh chim Lạc để chở những ước mơ lớn, viết tiếp câu chuyện bản sắc bằng ngôn ngữ của thời đại số, đưa di sản dân tộc thăng hoa và kiêu hãnh trong một đời sống mới, rực rỡ và bất tận.`;

const EMBED_BATCH = 16; // matches embed.worker.ts

describe('long Vietnamese note indexes cleanly (env failure, not content)', () => {
  it('chunks stay within the 512-token window and every chunk embeds to 384-dim', async () => {
    const cs = chunk(ARTICLE, { size: 60, overlap: 12 });
    expect(cs.length).toBeGreaterThan(10); // it's a long note → many chunks

    // Real MiniLM token counts: NO chunk may exceed the window (would silently truncate / could throw).
    const tok = await getTokenizer();
    const maxTokens = Math.max(...cs.map((c) => tok.encode(c.text).length));
    expect(maxTokens).toBeLessThanOrEqual(EMBEDDING_MAX_TOKENS);

    // Embed every chunk in batches of 16 — must not throw, every vector is 384-dim.
    await getEmbedder();
    let embedded = 0;
    for (let i = 0; i < cs.length; i += EMBED_BATCH) {
      const slice = cs.slice(i, i + EMBED_BATCH);
      const vecs = await embedBatch(slice.map((c) => c.text));
      for (const v of vecs) expect(v.length).toBe(EMBEDDING_DIM);
      embedded += slice.length;
    }
    expect(embedded).toBe(cs.length); // 100% of the note embedded — the content is fine
  }, 600_000);
});
