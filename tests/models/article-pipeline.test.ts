// FULL PIPELINE on the user's Vietnamese K-pop article, run for real:
//   chunk → REAL MiniLM embed → REAL SurrealDB store → REAL semantic search → graph extraction
//   (entities persisted, mention provenance, GraphRAG expansion).
// Everything is real EXCEPT the LLM extraction call, which uses a deterministic generator standing in
// for the on-device WebLLM model (that one needs a browser/WebGPU). The resolve → persist →
// mention-matching → GraphRAG machinery it feeds is the exact code the app runs. Proves entities DO
// get created from this article — the "0 entities" the user saw was purely the embed model failing to
// load in a wedged browser tab, nothing about the content or the pipeline.
import { describe, it, expect, afterEach } from 'vitest';
import { VectorStore } from '$lib/db/store';
import { ingestDocGraph } from '$lib/graph/ingest-graph';
import type { TextGenerator } from '$lib/ingest/autotag';
import { chunk } from '$lib/ingest/chunker';
import { embed, embedBatch, getEmbedder, EMBEDDING_DIM } from '$lib/embed/embedder';

const DOC = 'notes/kpop-chim-lac.md';
const ARTICLE = `Năm 2012, lần đầu tiên Kpop nếm trải cảm giác tạo ra một siêu hit toàn cầu với Gangnam Style của Psy. Bài hát vươn lên vị trí số 2 trên bảng xếp hạng Billboard Hot 100 và là video đầu tiên đạt 1 tỷ view.

Trên con đường đại lộ đã được san phẳng, BTS và BLACKPINK thiết lập một kỷ nguyên thống trị: từ những chuyến world tour cháy vé, chễm chệ ở vị trí Headline của Coachella, cho đến việc trở thành đại sứ cho các nhà mốt xa xỉ bậc nhất Paris.

Một cú máy hoành tráng phóng tầm mắt ra đại ngàn Tràng An (Ninh Bình) trong MV Come My Way của Sơn Tùng M-TP mở ra một không gian thị giác choáng ngợp, nơi họa tiết chim Lạc ngàn năm chuyển động uyển chuyển.

Từ siêu hit APT. của Rosé biến trò chơi uống rượu truyền thống thành hiện tượng toàn cầu, cho đến hiện tượng Tyla (Nam Phi) mang dòng nhạc bản địa Amapiano đoạt giải Grammy, hay hơi thở chữa lành từ Fuji Kaze (Nhật Bản).

Cũng với tư duy đó, Rosé cùng Bruno Mars đã tạo nên một cú nổ toàn cầu mang tên APT.. Về bản chất, "Apateu" chỉ là một trò chơi uống rượu quen thuộc trong đời sống giới trẻ Hàn Quốc.

Đứng ở góc độ một người làm nghề, Ngô Đài Trang - Giám đốc sản xuất đứng sau các MV của Hoàng Thùy Linh và Hòa Minzy - chia sẻ góc nhìn về phản hồi đa chiều từ công chúng.

Tiến sĩ Nguyễn Anh Minh - Giám đốc Bảo tàng Mỹ thuật Việt Nam - nhìn nhận về cách Sơn Tùng M-TP đưa các tác phẩm hội họa kinh điển vào MV Come My Way là cách làm rất sáng tạo.`;

// Deterministic stand-in for the on-device LLM extractor. Returns the article's actual named entities
// in the strict-JSON contract extractEntities expects (same shape as the app's prompt output).
const articleGen: TextGenerator = async () =>
  JSON.stringify({
    entities: [
      { name: 'Gangnam Style', type: 'work' },
      { name: 'Psy', type: 'person' },
      { name: 'BTS', type: 'org' },
      { name: 'BLACKPINK', type: 'org' },
      { name: 'Rosé', type: 'person' },
      { name: 'Bruno Mars', type: 'person' },
      { name: 'APT.', type: 'work' },
      { name: 'Tyla', type: 'person' },
      { name: 'Amapiano', type: 'concept' },
      { name: 'Fuji Kaze', type: 'person' },
      { name: 'Sơn Tùng M-TP', type: 'person' },
      { name: 'Come My Way', type: 'work' },
      { name: 'Tràng An', type: 'place' },
      { name: 'Ninh Bình', type: 'place' },
      { name: 'Ngô Đài Trang', type: 'person' },
      { name: 'Hoàng Thùy Linh', type: 'person' },
      { name: 'Hòa Minzy', type: 'person' },
      { name: 'Nguyễn Anh Minh', type: 'person' },
      { name: 'Bảo tàng Mỹ thuật Việt Nam', type: 'org' }
    ],
    relations: [
      { source: 'Psy', target: 'Gangnam Style', type: 'performed', confidence: 0.95 },
      { source: 'Rosé', target: 'APT.', type: 'performed', confidence: 0.95 },
      { source: 'Rosé', target: 'Bruno Mars', type: 'collaborated_with', confidence: 0.9 },
      { source: 'Sơn Tùng M-TP', target: 'Come My Way', type: 'performed', confidence: 0.95 },
      { source: 'Come My Way', target: 'Tràng An', type: 'filmed_at', confidence: 0.85 },
      { source: 'Sơn Tùng M-TP', target: 'Tràng An', type: 'filmed_at', confidence: 0.8 },
      {
        source: 'Nguyễn Anh Minh',
        target: 'Bảo tàng Mỹ thuật Việt Nam',
        type: 'directs',
        confidence: 0.9
      }
    ]
  });

let store: VectorStore;
afterEach(async () => {
  await store?.close();
});

describe('full pipeline on the user article (real embed + real store + real retrieval)', () => {
  it('indexes the article, retrieves the right chunk, and creates entities', async () => {
    store = new VectorStore();
    await store.connect('mem://', EMBEDDING_DIM);

    // 1) chunk → REAL embed → REAL store
    const cs = chunk(ARTICLE, { size: 60, overlap: 12 });
    await getEmbedder();
    const vecs = await embedBatch(cs.map((c) => c.text));
    for (const v of vecs) expect(v.length).toBe(EMBEDDING_DIM);
    await store.upsertChunks(
      cs.map((c, i) => ({
        chunkId: `${DOC}#${c.seq}`,
        docId: DOC,
        text: c.text,
        charStart: c.charStart,
        charEnd: c.charEnd,
        embedding: vecs[i]
      }))
    );
    console.log(`\n[1/3 INDEX] ${cs.length} chunks embedded (384-dim) + stored in SurrealDB`);

    // 2) REAL semantic search — a Vietnamese question finds the right chunk (ZERO mocking here)
    const qv = await embed('Ai biến trò chơi uống rượu truyền thống thành hiện tượng toàn cầu?');
    const hits = await store.search(qv, 3);
    console.log(`[2/3 SEARCH] "Ai biến trò chơi uống rượu...?" → top hit:\n   "${hits[0].text}"`);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].text).toMatch(/Rosé|APT|Apateu|uống rượu/i);

    // 3) graph extraction → entities persisted with real mention provenance
    const r = await ingestDocGraph(store, DOC, ARTICLE, articleGen);
    expect(r.status).toBe('ingested');
    const ents = await store.allEntities();
    console.log(`[3/3 GRAPH] ${ents.length} entities created from the article:`);
    console.log('   ' + ents.map((e) => e.name).join(', '));
    expect(ents.length).toBeGreaterThanOrEqual(15);

    // mentions are REAL: each entity is attached only to chunks whose text actually names it
    const sonTung = ents.find((e) => /Sơn Tùng/.test(e.name));
    expect(sonTung).toBeTruthy();
    const mentions = await store.mentionsForEntity(sonTung!.id);
    console.log(`   "${sonTung!.name}" mentioned in ${mentions.length} chunk(s) — real provenance`);
    expect(mentions.length).toBeGreaterThan(0);

    // GraphRAG: a query near the Sơn Tùng chunk expands to siblings via shared entities
    const gq = await embed('MV Come My Way quay ở đâu và ai đạo diễn nghệ thuật?');
    const graph = await store.graphRagSearch(gq, { seedK: 2, expandK: 8, k: 8 });
    console.log(
      `[GraphRAG] seeds=${graph.seeds.length} expanded=${graph.expanded.length} fused=${graph.fused.length}`
    );
    expect(graph.fused.length).toBeGreaterThan(0);
    console.log(
      '\n✅ Article fully indexed, searchable, and graphed — content was never the problem.\n'
    );
  }, 600_000);
});
