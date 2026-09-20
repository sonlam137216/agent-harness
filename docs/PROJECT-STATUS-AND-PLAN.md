# Tiến độ và kế hoạch phát triển Agent Harness

Ngày đánh giá: 20/09/2026.

Ghi chú: phần đánh giá bên dưới là snapshot trước triển khai Phase 2. Phase 2 sau đó đã được triển khai theo yêu cầu; trạng thái hiện hành xem ROADMAP.md và CONTEXT-ENGINE.md.

## Kết luận

Phase 0 đã hoàn thành. Phase 1 đã hoàn thành phạm vi core harness chỉ đọc theo roadmap hiện tại, xét trên mã nguồn trong working tree và kiểm thử tự động. Dự án có thể chuyển sang từng capability của Phase 2 khi được yêu cầu triển khai.

Đây là bản đánh giá và đề xuất kế hoạch, không phải thay đổi phạm vi đã được phê duyệt. Không triển khai capability mới trong lần đánh giá này.

## Bằng chứng và giới hạn đánh giá

- Đã đối chiếu `AGENTS.md`, `ARCHITECTURE.md`, `DESIGN-PRINCIPLES.md`, `ROADMAP.md`, `OBSERVABILITY.md`, mã nguồn và các kiểm thử liên quan.
- `pnpm validate` đạt: format, lint, typecheck, 21 test files / 86 tests và build.
- Kiểm thử CLI đi qua toàn bộ đường chạy với `FakeSampler`: prompt → model → đọc file thật trong thư mục tạm → model → câu trả lời; kiểm tra cả các span tương ứng.
- Các adapter OpenAI Responses, Anthropic Messages và Ollama Chat có kiểm thử với transport giả lập. Lần đánh giá này không gọi model thật; không coi kết quả này là xác nhận vận hành trên dịch vụ thật hoặc mọi model mode.
- HEAD tại thời điểm đánh giá: `6d3bc3d` (`feat: loop`). Trước khi thêm tài liệu này, working tree có 16 file đã theo dõi bị thay đổi và 8 file chưa được theo dõi. Kết luận bao gồm các thay đổi đó, không chỉ nội dung đã commit.
- Đây là đánh giá tiến độ và ranh giới kiến trúc, không phải audit bảo mật hay đo test coverage.

## Trạng thái hiện tại

| Phần | Trạng thái đã xác minh | Giới hạn hiện tại |
| --- | --- | --- |
| Foundation | TypeScript strict/ESM, scripts kiểm tra, logging, tracing và correlation IDs | Chưa có bằng chứng trong lần đánh giá này về pipeline CI chạy từ xa |
| Agent / Model | AgentDefinition, Sampler trung lập provider, ba adapter, CLI chọn provider/model | Provider continuation/reasoning đặc thù vẫn là phạm vi hoãn theo kiến trúc |
| Runtime | SessionRuntime đồng bộ; AgentLoop model/tool; giới hạn vòng lặp; cancellation/deadline; bảo toàn transcript khi vòng sau lỗi | Chưa có concurrency control hoặc chạy nền |
| Session | Session, Turn, SessionStore, InMemorySessionStore | Không sống qua restart; usage chưa được lưu trong transcript |
| Context | Ghép system prompt, toàn bộ transcript, tool definitions | Chưa có token budget, project rules, pruning hoặc compaction |
| Tools / Workspace | read_file, list_files, search_text; kiểm tra input; path containment; đọc có giới hạn | Không ghi file hoặc chạy lệnh; ToolBridge từ chối mọi access kind khác read |
| CLI | Một prompt, một lần chạy, in kết quả cuối | Không interactive, list/resume session hoặc hỏi quyền |
| Observability | Span session/turn/context/model/tool/workspace, usage, lỗi và retry metadata | Token theo từng nguồn context và lưu trữ lâu dài còn thuộc phase sau |
| Phase 2–12 | Chưa triển khai các capability chính theo roadmap | Không tính các seam/type có sẵn thành một phase hoàn thành |

## Các việc cần chốt trước capability tiếp theo

1. Rà soát và chốt một baseline cho các thay đổi đang có. Tách thay đổi củng cố core và thêm provider thành các nhóm review rõ ràng; không mặc định mọi thay đổi đã commit.
2. Dọn hai dòng debug `console.log` trong `src/cli/phase-one-cli.ts` (dòng 90–91 tại thời điểm đánh giá). Chúng in cấu hình trước khi áp dụng flags và tạo output phụ ngay khi parse tham số; hiện cả bộ test vẫn pass.
3. Đồng bộ phần Current Phase của `AGENTS.md` với việc đã có ba adapter; các mục CLI trong kiến trúc cũng nên phản ánh đủ provider selection. Đây là cập nhật tài liệu, không phải mở thêm chức năng.
4. Gắn milestone cụ thể cho công cụ sửa file/chạy lệnh. Roadmap hiện chỉ nói hoãn khỏi Phase 1 và cần permissions, nhưng chưa có checklist triển khai chúng ở phase sau.
5. Làm rõ mục `AccessKind` Phase 3: `ToolAccessKind` đã có trong `src/tools/tool-types.ts`; mở rộng/tái sử dụng một nguồn định nghĩa thay vì tạo type song song.
6. Nếu cần chốt mốc dùng thực tế, thực hiện một smoke test với provider/model mục tiêu: buộc đọc một fixture rồi trả lời dựa trên nội dung đó. Ghi lại model, kết quả, số vòng lặp và trace; không lưu credential hoặc prompt nhạy cảm.

## Kế hoạch gần: Phase 2 — Context Engine

Giữ trách nhiệm chọn thông tin và quyết định ngân sách trong Context. Runtime chỉ gọi boundary này; không tự tính token, đọc AGENTS.md hoặc quyết định nội dung cần bỏ.

| Slice | Phạm vi | Tiêu chí nghiệm thu |
| --- | --- | --- |
| 2.1 — Budget và accounting | Mở rộng ContextBuilder bằng giới hạn input, phần dự phòng output, số đo/ước lượng token theo system, conversation và tool schemas; overflow có lỗi rõ ràng | Test ngân sách vừa đủ/quá giới hạn; tính cả schema; trace contribution từng nguồn; phân biệt token ước lượng và usage thực tế từ provider |
| 2.2 — Context sources và project rules | Tách các nguồn đã có khi cần thêm nguồn rules; đọc AGENTS.md qua Workspace; xác định thứ tự, phạm vi root/nested và giới hạn kích thước | Rules được nạp đúng phạm vi, theo thứ tự xác định; không thoát workspace; không bị bỏ im lặng khi thiếu ngân sách; không biến nội dung file thành permission grant |
| 2.3 — Tool-result pruning | Rút gọn kết quả cũ ở bản context gửi model; giữ transcript gốc | Giữ nguyên tool-call ID và các nhóm call/result hợp lệ, nhất là batch nhiều tool; test kết quả lớn; quan sát được phần đã cắt |
| 2.4 — Compaction và checkpoint | Tóm tắt phần lịch sử đủ điều kiện; lưu checkpoint trong session hiện có; tiếp tục từ checkpoint và phần lịch sử gần nhất | Hội thoại dài vẫn hoàn thành dưới ngân sách; không mất yêu cầu đang xử lý hoặc tool result chưa ghép; summary lỗi/cancel không phá state; checkpoint Phase 2 chỉ ở memory |

Với 2.1, bắt đầu bằng cơ chế đếm/ước lượng có thể thay thế và test xác định được. Không hứa số token chính xác cho mọi provider. Cấu hình context window và output reserve phải được cấp rõ ràng; không suy đoán chỉ từ chuỗi model ID.

Nếu compaction dùng model, lời gọi phải qua Sampler và có trace, deadline, cancellation riêng. Context quyết định chiến lược; adapter tiếp tục sở hữu retry transport. Ghi checkpoint theo ranh giới hoàn chỉnh để không làm đứt transcript của tool calls. Durability cho checkpoint đến ở Phase 4.

Tài liệu cần cập nhật theo từng slice: ARCHITECTURE, ROADMAP và OBSERVABILITY. Tiêu chí kết thúc Phase 2 là một session dài qua nhiều turn có thể compact và tiếp tục, đồng thời giải thích được nguồn nào đã dùng ngân sách. Có thể kiểm chứng bằng integration test qua SessionRuntime trước khi thêm interactive CLI.

## Kế hoạch trung hạn: Phase 3–4

### Phase 3 — Permissions, công cụ thay đổi workspace, Hooks và Events

Đề xuất bổ sung công cụ thay đổi workspace vào Phase 3 thành các capability riêng, sau khi PermissionEngine hoạt động. Đây là phần mở rộng roadmap cần ghi nhận trước khi triển khai.

1. **3.1 — PermissionEngine:** thay guard read-only bằng quyết định allow/ask/deny; dùng lại access classification; `deny > ask > allow`; mode always-approve không vượt deny. CLI xử lý yêu cầu hỏi quyền; khi không có cơ chế hỏi, không tự cho phép.
2. **3.2 — Chỉnh sửa file:** thêm capability ghi hẹp trong Workspace, bắt đầu bằng một primitive sửa file như apply_patch; tool gọi qua ToolBridge. Kiểm tra path/symlink, input, xung đột nội dung và cancellation. Test deny bảo đảm file không đổi; không tự retry mutation.
3. **3.3 — Chạy lệnh:** thêm command capability hẹp, timeout/cancellation, giới hạn stdout/stderr, lọc environment và kiểm tra cwd. Kiểm tra quyền trước khi tạo process. Cwd containment không phải sandbox.
4. **3.4 — Events và Hooks:** định nghĩa một event model chung, thêm các hook có nhu cầu rõ ràng. Hook sửa arguments phải dẫn tới validate và authorize lại trước dispatch. Subscriber tracing không tạo span trùng; thiết kế persistence subscriber nối vào SessionStore hiện có, durability do Phase 4 đảm nhiệm.

Ranh giới: Runtime → ToolBridge → Permissions / Tool → Workspace. Quyền được cưỡng chế bằng code. Tool không gọi provider hoặc filesystem/process API trực tiếp. Chưa cho các agent song song sửa chung workspace.

Nghiệm thu: một tác vụ nhỏ đọc → đề xuất sửa → được cấp quyền → sửa → chạy kiểm tra → báo kết quả; ca từ chối không có side effect. Hooks/events mở rộng được lifecycle mà không mang logic nghiệp vụ vào loop. Permission, tool và workspace đều có correlation và lỗi chuẩn hóa.

### Phase 4 — Persistent Sessions

1. Chọn **một** backend đầu tiên. Đề xuất file JSON có schema version và ghi thay thế an toàn cho phạm vi một process; chỉ chọn SQLite ngay nếu truy vấn/concurrency là yêu cầu thực tế.
2. Lưu transcript, metadata, token usage và compaction checkpoints. Định nghĩa mốc ghi và trạng thái turn bị gián đoạn; không coi save đầu/cuối turn là bảo đảm khôi phục mọi side effect khi crash.
3. Bổ sung CLI list/resume/inspect. Khi có nhiều nguồn gửi turn vào cùng session, thêm capability giới hạn một active turn/session.
4. Thêm rewind hội thoại và trace/session correlation. Rewind chỉ thay đổi trạng thái hội thoại; không tự hoàn tác file hoặc chạy lại lệnh.

Nghiệm thu: tắt và khởi động lại process, resume đúng session, tiếp tục với checkpoint hợp lệ; xử lý có chủ đích file hỏng/version không hỗ trợ; không tự replay các mutation có kết quả chưa xác định.

## Kế hoạch dài hạn: Phase 5–12

| Phase | Thứ tự triển khai đề xuất | Điều kiện nghiệm thu / phụ thuộc |
| --- | --- | --- |
| 5 — Skills | Parser → project/user discovery và precedence → explicit invocation → budgeted context injection; automatic selection sau | Thêm workflow bằng SKILL.md mà không đổi TypeScript; rules/skills không vượt permissions; trace lựa chọn và token |
| 6 — MCP | Một stdio integration → adapter chuẩn hóa → catalog/name collision → search_tools/invoke_tool → BM25/refresh → HTTP và reconnect | 100+ tools trong catalog nhưng context thường trực nhỏ; lời gọi tool thực qua ToolBridge và được kiểm tra quyền theo tool đích, không chỉ meta-tool |
| 7 — Code Retrieval | Bộ tác vụ baseline → lexical retrieval → symbol/AST hoặc GitNexus nếu có lợi ích đo được; semantic search sau | Giảm input tokens/read_file calls trong khi giữ chất lượng kết quả; đo latency, nguồn đóng góp, số file và cache; Context chọn, Workspace đọc |
| 8 — Memory | Markdown có nguồn gốc/phạm vi → workspace/global → session summary → FTS/BM25 → retrieval lúc đầu session/sau compaction | Session mới tìm lại quyết định hữu ích; tách memory khỏi transcript và compaction; embeddings chỉ khi có bằng chứng cần |
| 9 — Subagents | Child session → giới hạn depth 1/capability/token → explore/review → chạy nền và handoff | Parent giao việc độc lập, hủy được và nhận kết quả có nguồn; liên kết traces; ban đầu chỉ đọc, chưa cho nhiều child sửa cùng workspace |
| 10 — Worktrees | Workspace implementation → tạo/gắn session → diff → apply/merge và xử lý conflict → cleanup | Hai session sửa code không chia sẻ working-tree state; cleanup không làm mất thay đổi chưa được xử lý |
| 11 — Sandbox | Policy rõ ràng → một backend isolation → kiểm thử filesystem/process/network theo phạm vi policy | Process thực sự bị giới hạn bên dưới permission layer; không đồng nhất worktree/path validation với OS isolation |
| 12 — Protocol / Clients | Một protocol server → session/prompt → streaming → permission round-trip → reconnect/cancel → một client | CLI và client dùng cùng Runtime; transport không nhân bản agent loop; khóa session khi concurrent access |

Giữ thứ tự roadmap hiện tại làm mặc định. Nếu sản phẩm cần chạy mã không tin cậy hoặc nhiều người dùng trước Phase 11, phải chủ động điều chỉnh thứ tự sandbox trước khi mở loại vận hành đó. Nếu chỉ dùng local có giám sát, có thể tiếp tục phạm vi đã giới hạn.

## Cách thực thi kế hoạch

- Mỗi thay đổi chỉ hoàn thành một capability chạy được end-to-end, kèm test hành vi, tracing và docs tương ứng.
- Ưu tiên gần nhất: chốt baseline hiện tại → Phase 2.1 budget/accounting → rules → pruning → compaction.
- Không thêm provider mới, vector database, orchestration framework hoặc nhiều storage backend chỉ để hoàn thiện sơ đồ kiến trúc.
- Chưa ước lượng lịch ngày/tuần vì chưa biết nguồn lực và mức độ kiểm chứng mong muốn. Dùng tiêu chí nghiệm thu để quyết định chuyển bước thay vì phần trăm hoàn thành của toàn bộ dự án.
- Tài liệu này không tự cho phép bắt đầu phase tiếp theo; giữ nguyên quy tắc chỉ triển khai capability mới khi được yêu cầu.
