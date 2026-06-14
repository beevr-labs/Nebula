// Bilingual onboarding seed (notes + pre-built knowledge graph + the "Start here" tour note).
//
// A brand-new user lands in a *populated* workspace so the app shows its value before they understand
// a thing about LLMs, indexes or graphs: they just click a suggested question and watch an answer
// appear with citations. The demo is two tiny notebooks with NO shared entities — a "Japan trip" in
// trip/ and a "sleep research" notebook in research/ — so Scope isolates them cleanly; within each,
// notes share people/places/ideas but few exact words, so GraphRAG + Reason connect them the way
// keyword search can't (e.g. "Sakura Inn" links the Kyoto note to the budget note).
//
// Why this is per-locale: the seed notes are DATA, not UI labels. They are written into the vault ONCE
// on first run and from then on belong to the user (editable, deletable). So we pick the language at
// seed time and never rewrite it under the user. UI strings stay reactive (i18n.svelte.ts); only this
// starter content is frozen at first-run. The hand-authored graph must use entity names that appear
// (case-insensitively, diacritics included) as substrings of their note text — mention edges attach by
// `text.toLowerCase().includes(name.toLowerCase())` (ingest-graph.seedDocGraph) — so each translation
// keeps proper nouns verbatim and translates only the concept entities (art→nghệ thuật, sleep→giấc ngủ).
//
// docId paths (trip/…, research/…, start-here.md) are IDENTICAL across locales on purpose: they key the
// graph, wikilinks ([[Hakone]]) and openInTab, and start-here references the trip/ folder for the Scope
// demo. Only the note TITLE/TEXT and entity display names are localized.

import type { Extraction, ExtractedRelation } from '$lib/graph/entities';
import type { Locale } from '$lib/i18n/i18n.svelte';

/** The onboarding tour note — visible/editable in the vault but NEVER RAG-indexed (it contains the
 *  example questions, which would otherwise self-match as the top hit for every suggestion). */
export const TOUR_DOC = 'start-here.md';

/** A seed note. Structurally a subset of the workspace `Note` (no kind/sourcePath/frontmatter). */
export type SeedNote = {
  docId: string;
  title: string;
  aliases: string[];
  text: string;
};

export type Seed = {
  notes: SeedNote[];
  graph: Record<string, Extraction>;
  tourDoc: string;
};

const r = (source: string, target: string, type: string): ExtractedRelation => ({
  source,
  target,
  type,
  confidence: 0.95
});

// ─────────────────────────────────────────────────────────────────────────────
// English
// ─────────────────────────────────────────────────────────────────────────────
const NOTES_EN: SeedNote[] = [
  {
    docId: 'start-here.md',
    title: '👋 Start here',
    aliases: ['Welcome', 'Start', 'Tour'],
    text: `# 👋 Welcome to Nebula

Nebula turns your notes into something you can **ask** — and everything runs **on your device**, so nothing ever leaves your computer.

This demo has two little notebooks so you can see what it does: a **Japan trip** with friends (\`trip/\`) and a **sleep research** notebook (\`research/\`). Try the things below, then delete it all and make it your own.

## 1 · Ask your notes  (press ⌘J)
- **Synthesize across notes:** *"What do Maya, Leo and Priya each want to do in Japan?"*
- **Add up the numbers:** *"How much is the Japan trip budget per person — flights, hotels, food and JR Pass?"*
- **Get advice, not just quotes** (turn on **Think it through**): *"Based on my sleep notes on caffeine, melatonin and the circadian rhythm, what should I change in my routine?"*
- **Follow up:** after an answer, ask *"and why?"* — it remembers the conversation.
- **Cited & verifiable:** answers show [#1] markers — click one to jump to the exact note.

## 2 · See how your notes connect
Nebula links your notes through shared **people, places and topics**, even when they share no words.
- In the sidebar under **People, places & topics**, open one like **Maya** or **caffeine** — you'll see every note connected to it.
- In Ask, try *"What is Maya planning in Tokyo, Kyoto and Osaka?"* — it gathers every note she appears in.

## 3 · Keep topics apart
Set the search to **trip/** and ask *"Summarize the Japan trip — Tokyo, Kyoto and Osaka"* — you'll only ever get trip notes, never your research.

## 4 · Make it yours
- **New note** to write; link notes with \`[[double brackets]]\`; tag with \`#hashtags\`.
- Drop in a **PDF or CSV** and it becomes searchable too.

#welcome`
  },

  // ── Japan trip with friends ───────────────────────────────────────────────
  {
    docId: 'trip/overview.md',
    title: 'Japan trip — overview',
    aliases: ['Japan trip', 'Japan'],
    text: 'Our 10-day Japan trip in April with Maya, Leo and Priya. The route is Tokyo → Kyoto → Osaka, plus a day trip to [[Hakone]]. Flights are booked and the budget target is about $1,900 each. #japan #trip'
  },
  {
    docId: 'trip/tokyo.md',
    title: 'Tokyo',
    aliases: ['Tokyo', 'Shinjuku'],
    text: 'In Tokyo (3 nights) we stay in Shinjuku. Maya wants teamLab Planets and Leo wants the Tsukiji fish market. From here we take a day trip to [[Hakone]]. #japan'
  },
  {
    docId: 'trip/kyoto.md',
    title: 'Kyoto',
    aliases: ['Kyoto', 'Sakura Inn', 'ryokan'],
    text: 'Kyoto (4 nights) is the temple leg: Fushimi Inari at dawn and the Arashiyama bamboo grove. Priya booked a traditional ryokan called Sakura Inn for two of the nights. #japan'
  },
  {
    docId: 'trip/osaka.md',
    title: 'Osaka',
    aliases: ['Osaka', 'Dotonbori'],
    text: 'Osaka (2 nights) is the food leg — Dotonbori street food and okonomiyaki. Leo is our foodie and is planning this part. #japan'
  },
  {
    docId: 'trip/hakone.md',
    title: 'Hakone day trip',
    aliases: ['Hakone'],
    text: 'A day trip to Hakone from Tokyo: Lake Ashi, the open-air museum and an onsen. Note: Maya is allergic to eggs, so we skip the famous black eggs. #japan'
  },
  {
    docId: 'trip/budget.md',
    title: 'Trip budget',
    aliases: ['budget', 'JR Pass'],
    text: 'Budget per person: flights $700, hotels $500, food $400, and a JR Pass for transport $300 — that comes to about $1,900 each. Maya already paid the Sakura Inn deposit of $150 on behalf of the group. #japan #money'
  },
  {
    docId: 'trip/preferences.md',
    title: 'What everyone wants',
    aliases: ['preferences'],
    text: 'Maya loves art and quiet temples. Leo lives for food and nightlife. Priya wants culture and shopping. We try to fit one thing for each person into every day. #japan'
  },

  // ── Sleep research notebook ───────────────────────────────────────────────
  {
    docId: 'research/overview.md',
    title: 'Sleep — overview',
    aliases: ['sleep', 'sleep research'],
    text: 'Notes on why sleep works the way it does. Two systems drive it: the circadian rhythm (a daily body clock) and sleep pressure (a chemical that builds up while you are awake). #sleep #research'
  },
  {
    docId: 'research/circadian.md',
    title: 'Circadian rhythm',
    aliases: ['circadian rhythm', 'circadian', 'SCN'],
    text: 'The circadian rhythm is a ~24-hour clock set mainly by light and run by the SCN in the hypothalamus. Morning light shifts it earlier; bright evening light shifts it later. #sleep'
  },
  {
    docId: 'research/adenosine.md',
    title: 'Sleep pressure & adenosine',
    aliases: ['adenosine', 'sleep pressure'],
    text: 'Sleep pressure comes from adenosine, which builds up in the brain the longer you stay awake and makes you drowsy. It clears out again while you sleep. #sleep'
  },
  {
    docId: 'research/caffeine.md',
    title: 'Caffeine',
    aliases: ['caffeine', 'coffee'],
    text: 'Caffeine works by blocking adenosine receptors, masking drowsiness. Its half-life is about 5–6 hours, so an afternoon coffee can still be active at bedtime. #sleep'
  },
  {
    docId: 'research/melatonin.md',
    title: 'Melatonin',
    aliases: ['melatonin', 'pineal gland'],
    text: 'Melatonin is released by the pineal gland when it gets dark and signals "night" to the body. Bright light in the evening suppresses it and pushes sleep later. #sleep'
  },
  {
    docId: 'research/why-we-sleep.md',
    title: 'Why We Sleep (notes)',
    aliases: ['Matthew Walker', 'Why We Sleep'],
    text: 'From "Why We Sleep" by Matthew Walker: deep NREM sleep helps consolidate memories, while REM sleep supports emotional regulation — both stages matter. #sleep #book'
  },
  {
    docId: 'research/takeaways.md',
    title: 'Sleep — what to actually do',
    aliases: ['sleep tips', 'takeaways'],
    text: 'Putting it together: get morning sunlight (it sets the circadian rhythm), stop caffeine after about 2 PM (its half-life is long), and dim the lights at night (to protect melatonin). #sleep'
  }
];

const GRAPH_EN: Record<string, Extraction> = {
  'trip/overview.md': {
    entities: [
      { name: 'Maya', type: 'person' },
      { name: 'Leo', type: 'person' },
      { name: 'Priya', type: 'person' },
      { name: 'Tokyo', type: 'place' },
      { name: 'Kyoto', type: 'place' },
      { name: 'Osaka', type: 'place' },
      { name: 'Hakone', type: 'place' }
    ],
    relations: []
  },
  'trip/tokyo.md': {
    entities: [
      { name: 'Tokyo', type: 'place' },
      { name: 'Shinjuku', type: 'place' },
      { name: 'Maya', type: 'person' },
      { name: 'teamLab Planets', type: 'place' },
      { name: 'Leo', type: 'person' },
      { name: 'Tsukiji', type: 'place' },
      { name: 'Hakone', type: 'place' }
    ],
    relations: [
      r('Maya', 'teamLab Planets', 'wants_to_visit'),
      r('Leo', 'Tsukiji', 'wants_to_visit')
    ]
  },
  'trip/kyoto.md': {
    entities: [
      { name: 'Kyoto', type: 'place' },
      { name: 'Fushimi Inari', type: 'place' },
      { name: 'Arashiyama', type: 'place' },
      { name: 'Priya', type: 'person' },
      { name: 'Sakura Inn', type: 'org' }
    ],
    relations: [r('Priya', 'Sakura Inn', 'booked'), r('Sakura Inn', 'Kyoto', 'located_in')]
  },
  'trip/osaka.md': {
    entities: [
      { name: 'Osaka', type: 'place' },
      { name: 'Dotonbori', type: 'place' },
      { name: 'Leo', type: 'person' },
      { name: 'food', type: 'concept' }
    ],
    relations: [r('Leo', 'Osaka', 'plans'), r('Leo', 'food', 'likes')]
  },
  'trip/hakone.md': {
    entities: [
      { name: 'Hakone', type: 'place' },
      { name: 'Tokyo', type: 'place' },
      { name: 'Lake Ashi', type: 'place' },
      { name: 'Maya', type: 'person' }
    ],
    relations: [r('Hakone', 'Tokyo', 'day_trip_from')]
  },
  'trip/budget.md': {
    entities: [
      { name: 'Maya', type: 'person' },
      { name: 'Sakura Inn', type: 'org' },
      { name: 'JR Pass', type: 'other' }
    ],
    relations: [r('Maya', 'Sakura Inn', 'paid_deposit')]
  },
  'trip/preferences.md': {
    entities: [
      { name: 'Maya', type: 'person' },
      { name: 'Leo', type: 'person' },
      { name: 'Priya', type: 'person' },
      { name: 'art', type: 'concept' },
      { name: 'food', type: 'concept' },
      { name: 'shopping', type: 'concept' }
    ],
    relations: [
      r('Maya', 'art', 'likes'),
      r('Leo', 'food', 'likes'),
      r('Priya', 'shopping', 'likes')
    ]
  },
  'research/overview.md': {
    entities: [
      { name: 'circadian rhythm', type: 'concept' },
      { name: 'sleep pressure', type: 'concept' },
      { name: 'sleep', type: 'concept' }
    ],
    relations: [
      r('circadian rhythm', 'sleep', 'regulates'),
      r('sleep pressure', 'sleep', 'regulates')
    ]
  },
  'research/circadian.md': {
    entities: [
      { name: 'circadian rhythm', type: 'concept' },
      { name: 'SCN', type: 'concept' },
      { name: 'hypothalamus', type: 'place' },
      { name: 'light', type: 'concept' }
    ],
    relations: [r('SCN', 'circadian rhythm', 'controls'), r('light', 'circadian rhythm', 'sets')]
  },
  'research/adenosine.md': {
    entities: [
      { name: 'sleep pressure', type: 'concept' },
      { name: 'adenosine', type: 'concept' }
    ],
    relations: [r('adenosine', 'sleep pressure', 'causes')]
  },
  'research/caffeine.md': {
    entities: [
      { name: 'caffeine', type: 'concept' },
      { name: 'adenosine', type: 'concept' }
    ],
    relations: [r('caffeine', 'adenosine', 'blocks')]
  },
  'research/melatonin.md': {
    entities: [
      { name: 'melatonin', type: 'concept' },
      { name: 'pineal gland', type: 'concept' },
      { name: 'light', type: 'concept' }
    ],
    relations: [r('pineal gland', 'melatonin', 'releases'), r('light', 'melatonin', 'suppresses')]
  },
  'research/why-we-sleep.md': {
    entities: [
      { name: 'Why We Sleep', type: 'other' },
      { name: 'Matthew Walker', type: 'person' },
      { name: 'NREM', type: 'concept' },
      { name: 'REM', type: 'concept' }
    ],
    relations: [r('Matthew Walker', 'Why We Sleep', 'wrote')]
  },
  'research/takeaways.md': {
    entities: [
      { name: 'circadian rhythm', type: 'concept' },
      { name: 'caffeine', type: 'concept' },
      { name: 'melatonin', type: 'concept' }
    ],
    relations: []
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// Vietnamese — proper nouns kept verbatim; only concept entities translated, each kept as a
// substring of its note text so mention edges still attach.
// ─────────────────────────────────────────────────────────────────────────────
const NOTES_VI: SeedNote[] = [
  {
    docId: 'start-here.md',
    title: '👋 Bắt đầu tại đây',
    aliases: ['Chào mừng', 'Bắt đầu', 'Hướng dẫn'],
    text: `# 👋 Chào mừng đến với Nebula

Nebula biến ghi chú của bạn thành thứ bạn có thể **hỏi** — và mọi thứ chạy **ngay trên máy bạn**, nên không gì rời khỏi thiết bị của bạn.

Bản dùng thử này có hai cuốn sổ nhỏ để bạn thấy nó làm được gì: một **chuyến đi Nhật** cùng bạn bè (\`trip/\`) và một cuốn sổ **nghiên cứu giấc ngủ** (\`research/\`). Thử những việc bên dưới, rồi xóa hết và biến nó thành của riêng bạn.

## 1 · Hỏi ghi chú của bạn  (nhấn ⌘J)
- **Tổng hợp nhiều ghi chú:** *"Maya, Leo và Priya mỗi người muốn làm gì ở Nhật?"*
- **Cộng các con số:** *"Ngân sách chuyến đi Nhật mỗi người là bao nhiêu — vé máy bay, khách sạn, ăn uống và JR Pass?"*
- **Xin lời khuyên, không chỉ trích dẫn** (bật **Suy luận giúp tôi**): *"Dựa trên ghi chú của tôi về caffeine, melatonin và nhịp sinh học, tôi nên thay đổi gì trong thói quen?"*
- **Hỏi tiếp:** sau một câu trả lời, hỏi *"vì sao vậy?"* — nó nhớ cuộc trò chuyện.
- **Có dẫn nguồn, kiểm chứng được:** câu trả lời hiện ký hiệu [#1] — bấm vào để nhảy tới đúng ghi chú.

## 2 · Xem ghi chú của bạn kết nối thế nào
Nebula liên kết ghi chú của bạn qua **người, nơi chốn và chủ đề** chung, kể cả khi chúng không chung từ nào.
- Ở thanh bên, mục **Người, nơi chốn & chủ đề**, mở một mục như **Maya** hoặc **caffeine** — bạn sẽ thấy mọi ghi chú nối với nó.
- Trong ô Hỏi, thử *"Maya dự định gì ở Tokyo, Kyoto và Osaka?"* — nó gom mọi ghi chú có cô ấy.

## 3 · Giữ các chủ đề tách biệt
Đặt phạm vi tìm là **trip/** rồi hỏi *"Tóm tắt chuyến đi Nhật — Tokyo, Kyoto và Osaka"* — bạn chỉ nhận được ghi chú chuyến đi, không bao giờ lẫn phần nghiên cứu.

## 4 · Biến nó thành của bạn
- **Ghi chú mới** để viết; liên kết ghi chú bằng \`[[hai dấu ngoặc]]\`; gắn thẻ bằng \`#hashtag\`.
- Thả vào một file **PDF hoặc CSV** và nó cũng tìm kiếm được.

#welcome`
  },

  // ── Chuyến đi Nhật cùng bạn bè ─────────────────────────────────────────────
  {
    docId: 'trip/overview.md',
    title: 'Chuyến đi Nhật — tổng quan',
    aliases: ['Chuyến đi Nhật', 'Nhật Bản'],
    text: 'Chuyến đi Nhật 10 ngày vào tháng Tư cùng Maya, Leo và Priya. Lộ trình là Tokyo → Kyoto → Osaka, cộng thêm một chuyến trong ngày tới [[Hakone]]. Vé máy bay đã đặt và ngân sách mục tiêu khoảng $1,900 mỗi người. #nhatban #chuyendi'
  },
  {
    docId: 'trip/tokyo.md',
    title: 'Tokyo',
    aliases: ['Tokyo', 'Shinjuku'],
    text: 'Ở Tokyo (3 đêm) chúng tôi ở Shinjuku. Maya muốn đi teamLab Planets còn Leo muốn đi chợ cá Tsukiji. Từ đây chúng tôi đi một chuyến trong ngày tới [[Hakone]]. #nhatban'
  },
  {
    docId: 'trip/kyoto.md',
    title: 'Kyoto',
    aliases: ['Kyoto', 'Sakura Inn', 'ryokan'],
    text: 'Kyoto (4 đêm) là chặng đền chùa: Fushimi Inari lúc bình minh và rừng tre Arashiyama. Priya đã đặt một nhà trọ ryokan truyền thống tên là Sakura Inn cho hai trong số các đêm. #nhatban'
  },
  {
    docId: 'trip/osaka.md',
    title: 'Osaka',
    aliases: ['Osaka', 'Dotonbori'],
    text: 'Osaka (2 đêm) là chặng ẩm thực — đồ ăn đường phố Dotonbori và món okonomiyaki. Leo là tín đồ ẩm thực và đang lên kế hoạch phần này. #nhatban'
  },
  {
    docId: 'trip/hakone.md',
    title: 'Chuyến trong ngày tới Hakone',
    aliases: ['Hakone'],
    text: 'Một chuyến trong ngày tới Hakone từ Tokyo: hồ Ashi, bảo tàng ngoài trời và một suối nước nóng onsen. Lưu ý: Maya bị dị ứng trứng nên chúng tôi bỏ qua món trứng đen nổi tiếng. #nhatban'
  },
  {
    docId: 'trip/budget.md',
    title: 'Ngân sách chuyến đi',
    aliases: ['ngân sách', 'JR Pass'],
    text: 'Ngân sách mỗi người: vé máy bay $700, khách sạn $500, ăn uống $400, và vé JR Pass đi lại $300 — tổng cộng khoảng $1,900 mỗi người. Maya đã trả trước tiền cọc $150 cho Sakura Inn thay cho cả nhóm. #nhatban #tienbac'
  },
  {
    docId: 'trip/preferences.md',
    title: 'Mỗi người thích gì',
    aliases: ['sở thích'],
    text: 'Maya mê nghệ thuật và những ngôi đền yên tĩnh. Leo sống vì ẩm thực và cuộc sống về đêm. Priya thích văn hóa và mua sắm. Chúng tôi cố sắp xếp mỗi ngày một thứ cho mỗi người. #nhatban'
  },

  // ── Cuốn sổ nghiên cứu giấc ngủ ────────────────────────────────────────────
  {
    docId: 'research/overview.md',
    title: 'Giấc ngủ — tổng quan',
    aliases: ['giấc ngủ', 'nghiên cứu giấc ngủ'],
    text: 'Ghi chú về vì sao giấc ngủ vận hành như vậy. Hai hệ thống chi phối nó: nhịp sinh học (đồng hồ cơ thể theo ngày) và áp lực ngủ (một chất hóa học tích tụ khi bạn thức). #giacngu #nghiencuu'
  },
  {
    docId: 'research/circadian.md',
    title: 'Nhịp sinh học',
    aliases: ['nhịp sinh học', 'circadian', 'SCN'],
    text: 'Nhịp sinh học là đồng hồ ~24 giờ, được thiết lập chủ yếu bởi ánh sáng và điều khiển bởi SCN ở vùng dưới đồi. Ánh sáng buổi sáng đẩy nó sớm hơn; ánh sáng mạnh buổi tối đẩy nó muộn hơn. #giacngu'
  },
  {
    docId: 'research/adenosine.md',
    title: 'Áp lực ngủ & adenosine',
    aliases: ['adenosine', 'áp lực ngủ'],
    text: 'Áp lực ngủ đến từ adenosine, chất tích tụ trong não càng lâu khi bạn càng thức và khiến bạn buồn ngủ. Nó được dọn đi khi bạn ngủ. #giacngu'
  },
  {
    docId: 'research/caffeine.md',
    title: 'Caffeine',
    aliases: ['caffeine', 'cà phê'],
    text: 'Caffeine hoạt động bằng cách chặn các thụ thể adenosine, che lấp cảm giác buồn ngủ. Thời gian bán hủy của nó khoảng 5–6 giờ, nên một ly cà phê buổi chiều vẫn có thể còn tác dụng lúc đi ngủ. #giacngu'
  },
  {
    docId: 'research/melatonin.md',
    title: 'Melatonin',
    aliases: ['melatonin', 'tuyến tùng'],
    text: 'Melatonin được tuyến tùng tiết ra khi trời tối và báo hiệu "ban đêm" cho cơ thể. Ánh sáng mạnh vào buổi tối ức chế nó và đẩy giấc ngủ muộn hơn. #giacngu'
  },
  {
    docId: 'research/why-we-sleep.md',
    title: 'Why We Sleep (ghi chú)',
    aliases: ['Matthew Walker', 'Why We Sleep'],
    text: 'Từ cuốn "Why We Sleep" của Matthew Walker: giấc ngủ sâu NREM giúp củng cố trí nhớ, còn giấc ngủ REM hỗ trợ điều hòa cảm xúc — cả hai giai đoạn đều quan trọng. #giacngu #sach'
  },
  {
    docId: 'research/takeaways.md',
    title: 'Giấc ngủ — nên làm gì',
    aliases: ['mẹo ngủ', 'kết luận'],
    text: 'Gộp lại: đón ánh sáng mặt trời buổi sáng (nó thiết lập nhịp sinh học), ngừng caffeine sau khoảng 2 giờ chiều (thời gian bán hủy dài), và giảm đèn vào buổi tối (để bảo vệ melatonin). #giacngu'
  }
];

const GRAPH_VI: Record<string, Extraction> = {
  'trip/overview.md': {
    entities: [
      { name: 'Maya', type: 'person' },
      { name: 'Leo', type: 'person' },
      { name: 'Priya', type: 'person' },
      { name: 'Tokyo', type: 'place' },
      { name: 'Kyoto', type: 'place' },
      { name: 'Osaka', type: 'place' },
      { name: 'Hakone', type: 'place' }
    ],
    relations: []
  },
  'trip/tokyo.md': {
    entities: [
      { name: 'Tokyo', type: 'place' },
      { name: 'Shinjuku', type: 'place' },
      { name: 'Maya', type: 'person' },
      { name: 'teamLab Planets', type: 'place' },
      { name: 'Leo', type: 'person' },
      { name: 'Tsukiji', type: 'place' },
      { name: 'Hakone', type: 'place' }
    ],
    relations: [
      r('Maya', 'teamLab Planets', 'wants_to_visit'),
      r('Leo', 'Tsukiji', 'wants_to_visit')
    ]
  },
  'trip/kyoto.md': {
    entities: [
      { name: 'Kyoto', type: 'place' },
      { name: 'Fushimi Inari', type: 'place' },
      { name: 'Arashiyama', type: 'place' },
      { name: 'Priya', type: 'person' },
      { name: 'Sakura Inn', type: 'org' }
    ],
    relations: [r('Priya', 'Sakura Inn', 'booked'), r('Sakura Inn', 'Kyoto', 'located_in')]
  },
  'trip/osaka.md': {
    entities: [
      { name: 'Osaka', type: 'place' },
      { name: 'Dotonbori', type: 'place' },
      { name: 'Leo', type: 'person' },
      { name: 'ẩm thực', type: 'concept' }
    ],
    relations: [r('Leo', 'Osaka', 'plans'), r('Leo', 'ẩm thực', 'likes')]
  },
  'trip/hakone.md': {
    entities: [
      { name: 'Hakone', type: 'place' },
      { name: 'Tokyo', type: 'place' },
      { name: 'hồ Ashi', type: 'place' },
      { name: 'Maya', type: 'person' }
    ],
    relations: [r('Hakone', 'Tokyo', 'day_trip_from')]
  },
  'trip/budget.md': {
    entities: [
      { name: 'Maya', type: 'person' },
      { name: 'Sakura Inn', type: 'org' },
      { name: 'JR Pass', type: 'other' }
    ],
    relations: [r('Maya', 'Sakura Inn', 'paid_deposit')]
  },
  'trip/preferences.md': {
    entities: [
      { name: 'Maya', type: 'person' },
      { name: 'Leo', type: 'person' },
      { name: 'Priya', type: 'person' },
      { name: 'nghệ thuật', type: 'concept' },
      { name: 'ẩm thực', type: 'concept' },
      { name: 'mua sắm', type: 'concept' }
    ],
    relations: [
      r('Maya', 'nghệ thuật', 'likes'),
      r('Leo', 'ẩm thực', 'likes'),
      r('Priya', 'mua sắm', 'likes')
    ]
  },
  'research/overview.md': {
    entities: [
      { name: 'nhịp sinh học', type: 'concept' },
      { name: 'áp lực ngủ', type: 'concept' },
      { name: 'giấc ngủ', type: 'concept' }
    ],
    relations: [
      r('nhịp sinh học', 'giấc ngủ', 'regulates'),
      r('áp lực ngủ', 'giấc ngủ', 'regulates')
    ]
  },
  'research/circadian.md': {
    entities: [
      { name: 'nhịp sinh học', type: 'concept' },
      { name: 'SCN', type: 'concept' },
      { name: 'vùng dưới đồi', type: 'place' },
      { name: 'ánh sáng', type: 'concept' }
    ],
    relations: [r('SCN', 'nhịp sinh học', 'controls'), r('ánh sáng', 'nhịp sinh học', 'sets')]
  },
  'research/adenosine.md': {
    entities: [
      { name: 'áp lực ngủ', type: 'concept' },
      { name: 'adenosine', type: 'concept' }
    ],
    relations: [r('adenosine', 'áp lực ngủ', 'causes')]
  },
  'research/caffeine.md': {
    entities: [
      { name: 'caffeine', type: 'concept' },
      { name: 'adenosine', type: 'concept' }
    ],
    relations: [r('caffeine', 'adenosine', 'blocks')]
  },
  'research/melatonin.md': {
    entities: [
      { name: 'melatonin', type: 'concept' },
      { name: 'tuyến tùng', type: 'concept' },
      { name: 'ánh sáng', type: 'concept' }
    ],
    relations: [r('tuyến tùng', 'melatonin', 'releases'), r('ánh sáng', 'melatonin', 'suppresses')]
  },
  'research/why-we-sleep.md': {
    entities: [
      { name: 'Why We Sleep', type: 'other' },
      { name: 'Matthew Walker', type: 'person' },
      { name: 'NREM', type: 'concept' },
      { name: 'REM', type: 'concept' }
    ],
    relations: [r('Matthew Walker', 'Why We Sleep', 'wrote')]
  },
  'research/takeaways.md': {
    entities: [
      { name: 'nhịp sinh học', type: 'concept' },
      { name: 'caffeine', type: 'concept' },
      { name: 'melatonin', type: 'concept' }
    ],
    relations: []
  }
};

/** Pick the starter notebooks + pre-built graph for `locale`. Called once at first-run seed time, so
 *  the demo content is frozen in the language the user chose at the gate; UI labels stay reactive. */
export function getSeed(locale: Locale): Seed {
  return locale === 'vi'
    ? { notes: NOTES_VI, graph: GRAPH_VI, tourDoc: TOUR_DOC }
    : { notes: NOTES_EN, graph: GRAPH_EN, tourDoc: TOUR_DOC };
}
