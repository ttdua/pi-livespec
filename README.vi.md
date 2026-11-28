# pi-livespec

[English](README.md) | **Tiếng Việt**

Extension cho [pi](https://github.com/earendil-works/pi) giữ coding agent đi đúng quy trình spec-driven, không cho phép bỏ bước. Mỗi change nằm trên một issue của forge (GitHub hoặc Gitea), living spec nằm trong repository dưới `specs/`, và mỗi phase kết thúc ở một gate mà chỉ con người, hoặc một check đã pass, mới mở được.

> **Trạng thái: v0.2.0.** Mọi spec trong roadmap đến LS-10 đã được xây dựng, cùng với briefing cho request và dialog in-session. Phần dogfood so sánh với pi-superspec ([LS-11](https://github.com/ttdua/pi-livespec/issues/11)) vẫn đang tiến hành. Xem [changelog](CHANGELOG.md) (tiếng Anh).

**README này gồm:** livespec làm gì, cách cài đặt và thiết lập, cách chạy từng luồng công việc theo từng bước, kể cả việc bạn cần đọc gì và trả lời ra sao ở mỗi human gate. Tài liệu giả định bạn đã dùng pi và git. Chi tiết bên trong xem ở [Architecture](docs/architecture.md) (tiếng Anh).

Tên lệnh, tool, key config, phase, label và từ khóa (SHALL, WHEN, THEN) được giữ nguyên tiếng Anh vì đó là thứ bạn gõ hoặc nhìn thấy trên màn hình.

## Mục lục

- [livespec làm gì](#livespec-làm-gì)
- [Yêu cầu](#yêu-cầu)
- [Cài đặt và thiết lập project](#cài-đặt-và-thiết-lập-project)
- [Cách làm việc với livespec](#cách-làm-việc-với-livespec)
- [Luồng 1: một change đầy đủ](#luồng-1-một-change-đầy-đủ)
- [Human gate: đọc gì và trả lời thế nào](#human-gate-đọc-gì-và-trả-lời-thế-nào)
- [Luồng 2: sửa lỗi nhỏ](#luồng-2-sửa-lỗi-nhỏ)
- [Luồng 3: initiative gồm nhiều change](#luồng-3-initiative-gồm-nhiều-change)
- [Luồng 4: phát hiện dependency giữa lúc build](#luồng-4-phát-hiện-dependency-giữa-lúc-build)
- [Luồng 5: drift audit](#luồng-5-drift-audit)
- [Chuyển từ OpenSpec](#chuyển-từ-openspec)
- [Tùy chọn: subagent và parallel lane](#tùy-chọn-subagent-và-parallel-lane)
- [Tham khảo](#tham-khảo)
- [Xử lý sự cố](#xử-lý-sự-cố)

## livespec làm gì

Trong session dài, agent hay quên bước: bỏ qua verify hoặc review, mất state, hoặc tuyên bố đã xong mà không có bằng chứng. Một skill chỉ *nhắc* agent làm đúng thì không ngăn được điều này. livespec chuyển quy trình vào extension:

- **Extension nắm quy trình.** Một flow pack (YAML) định nghĩa các phase `shape → define → plan → build → review → ship → close`. livespec tính bước tiếp theo, hiển thị nó trên **phase card** mỗi lượt, và từ chối các tool mà state không cho phép.
- **Change nằm trên issue.** Body của issue chứa proposal, design, câu hỏi và unit. Comment do tool viết chứa quyết định gate; receipt và review finding nằm trong git ledger. Mỗi change được ship đúng bằng một pull request.
- **Living spec nằm trong repo.** `specs/<capability>/spec.md` được sửa trực tiếp trên change branch, nên phần thay đổi spec là một phần của diff pull request.
- **Bằng chứng do extension thu thập, không phải do agent tự nhận.** Mỗi unit có một lệnh `Verify`. livespec chạy lệnh đó, yêu cầu nó fail trước khi làm và pass sau khi làm, rồi ghi receipt. Chỉ livespec mới đánh dấu unit là done.
- **Con người duyệt gate.** Yêu cầu duyệt, câu hỏi và stuck report đến với bạn qua dialog trong pi hoặc comment trên issue. Không tool nào nhận tham số "approved", nên agent không thể tự duyệt công việc của mình.
- **Guard chặn đường tắt.** `git push` trực tiếp, ghi forge trực tiếp (`gh`, `tea`, `curl` tới forge) và sửa `.pi/livespec/` đều bị chặn; tool của livespec chỉ push sau khi đã kiểm tra state.

Phương pháp lấy từ [agent-skills](https://github.com/addyosmani/agent-skills): livespec nạp skill tương ứng với từng phase. Một số ý tưởng được mượn từ [OpenSpec](https://github.com/Fission-AI/OpenSpec), litespec và [pi-superspec](https://github.com/ttdua/pi-superspec).

## Yêu cầu

**Bắt buộc**

| Công cụ | Vì sao | Kiểm tra |
|---|---|---|
| [pi](https://github.com/earendil-works/pi) (`@earendil-works/pi-coding-agent`) | livespec là extension của pi | `pi --version` |
| `git` | branch, worktree, receipt. Nên dùng 2.38 trở lên: git cũ hơn tắt ngoại lệ clean-merge ở ship và kiểm tra empty-fix chính xác | `git --version` |
| Git remote tên `origin` trên GitHub hoặc Gitea | livespec xác định forge từ remote này | `git remote -v` |
| **GitHub:** [`gh`](https://cli.github.com/) đã đăng nhập, có quyền write vào repo | issue, comment, pull request | `gh auth status` |
| **Gitea:** một login `tea` cho server, hoặc `GITEA_TOKEN` trong môi trường | livespec đọc token từ config của `tea`; không bao giờ chạy `tea` | `tea login list` |
| Lệnh test của project | small-fix lane chạy lệnh này trước khi ship (`testCommand`) | — |

**Tùy chọn** (mỗi mục đều có phương án dự phòng)

| Package | Bổ sung | Khi không có |
|---|---|---|
| [`@ttdua/pi-subagents`](https://github.com/ttdua/pi-subagents) ≥ 0.1.1 | child scout, implementer, reviewer, verifier; parallel lane | mọi role chạy inline trong session của bạn và để lại cùng bằng chứng |
| [pi-jev-pilot](https://github.com/ttdua/pi-jev-pilot) ≥ 0.6.0 | định tuyến model cho child | agent file của role và setting pi của bạn chọn model |
| Forge approver (`interaction.adapter: [forge]`) | trả lời gate bằng comment trên issue, từ bất cứ đâu | gate được trả lời qua dialog trong pi (`in-session`, mặc định) |

## Cài đặt và thiết lập project

Bước 1–2 làm một lần mỗi máy, bước 3–7 làm một lần mỗi repository.

1. **Cài extension.**

   ```sh
   pi install git:github.com/ttdua/pi-livespec@v0.2.0
   ```

   Bỏ `@v0.2.0` nếu muốn theo `main` thay vì bản release.

2. **Đăng nhập forge** bằng tài khoản có quyền write vào repository.

   ```sh
   gh auth login                 # GitHub
   tea login add                 # Gitea (hoặc export GITEA_TOKEN=...)
   ```

3. **Mở pi trong repository** trên integration branch (thường là `main`), với working tree sạch.

   ```sh
   cd my-project && pi
   ```

   Project chưa khởi tạo thì không có phase card. pi gợi ý `/livespec init` (hoặc `/livespec migrate-openspec` khi có thư mục `openspec/`; xem [Chuyển từ OpenSpec](#chuyển-từ-openspec)).

4. **Khởi tạo livespec.**

   ```text
   /livespec init
   /reload
   ```

   `init` chỉ tạo những gì còn thiếu, nên chạy lại vẫn an toàn:

   ```text
   specs/product.md          sản phẩm là gì, phục vụ ai
   specs/glossary.md         thuật ngữ chung, mỗi dòng một mục
   specs/constraints.md      chuẩn chất lượng mọi change phải tuân theo
   specs/decisions/          decision record
   .pi/livespec/config.yaml  config project, mọi key đều đang comment
   ```

   Lệnh này cũng clone agent-skills vào `~/.pi/agent/livespec/agent-skills/` (dùng chung cho mọi project).

5. **Thiết lập config project.** Sửa `.pi/livespec/config.yaml`. Tối thiểu hãy đặt lệnh test; chỉ đặt forge khi không tự nhận diện được từ `origin` (server tự host):

   ```yaml
   testCommand: bun test           # fix_ship chạy lệnh này; phải exit 0
   # forge: gitea
   # giteaUrl: https://gitea.example.com
   # integrationBranch: main
   ```

   Danh sách đầy đủ các key ở mục [Cấu hình](#cấu-hình).

6. **Soạn durable docs.** Khi `specs/constraints.md` chưa được soạn, phase card yêu cầu agent soạn nó bằng skill `constraint-driven-development`. Hãy nhờ agent làm, rồi tự đọc và sửa `specs/product.md` và `specs/constraints.md`: mọi phase về sau đều đọc hai file này. Xóa dòng template marker ở đầu `constraints.md` khi đã soạn xong.

7. **Kiểm tra thiết lập và commit.**

   ```text
   /livespec doctor
   /livespec validate
   ```

   Doctor không được báo `error` nào. Nó cho biết tài khoản forge sẽ dùng để ghi, approver chain và adapter sẽ trả lời lúc này, commit agent-skills, và mọi package xung đột. Sau đó commit `specs/` và `.pi/livespec/` lên integration branch.

   > **Đang bật Superpowers hoặc pi-superspec?** Doctor cảnh báo Superpowers cạnh tranh với flow của livespec. Hãy tắt nó cho project này để agent chỉ làm theo phase card.

## Cách làm việc với livespec

Bạn trò chuyện với agent như bình thường. livespec thêm ba thứ mà cả agent và bạn đều dựa vào:

- **Phase card.** Mỗi lượt, agent thấy change, phase, các bộ đếm, các check đang fail và **đúng một bước tiếp theo**. Hỏi "bước tiếp theo là gì?" hoặc chạy `/livespec next` để tự xem cùng câu đó.
- **Tool của livespec.** Agent gọi các tool như `change_new`, `spec_gate` hay `unit_finish`. Bạn không cần tự gõ lời gọi tool; chỉ cần nói bằng ngôn ngữ thường ("tạo change cho X", "request define gate", "ship đi"). Khi bước tiếp theo ghi *a human runs X*, livespec chờ **bạn** bảo agent làm việc đó.
- **Yêu cầu chờ bạn.** Gate, câu hỏi, stuck report và một số quyết định chờ con người trả lời. Với adapter mặc định `in-session`, chúng hiện thành một dialog của pi cho mỗi request ngay trong lời gọi tool; với adapter `forge`, chúng hiện thành comment trên issue và bạn trả lời bằng comment `/livespec …`.

**Quy tắc nhanh:** khi agent dừng và card ghi "Wait for the human's answer to …", đó là lượt của bạn. Mọi việc khác agent tự làm được.

## Luồng 1: một change đầy đủ

Dùng cho mọi change thêm hoặc đổi hành vi. Một change = một issue = một branch `livespec/<name>` = một pull request.

| Phase | Ai làm | Kết thúc bằng |
|---|---|---|
| `shape` | agent phỏng vấn bạn | self gate (chỉ check) |
| `define` | agent viết proposal và phần thay đổi spec | **human gate** |
| `plan` | agent chia việc thành unit | self gate, **human** khi escalate |
| `build` | agent (hoặc child implementer) build từng unit | mọi unit được tick kèm receipt |
| `review` | reviewer, verifier, agent sửa | self gate (`review-clean`) |
| `ship` | agent điền bảng durable docs và mở PR | **human gate**, rồi `change_ship` |
| `close` | bạn merge PR; agent đóng issue | `change_close` |

### 1. Shape: nói điều bạn muốn

Nói ý định với agent bằng lời thường:

```text
Start a livespec change: limit each client IP to 100 requests per minute.
```

Agent chạy `change_new <name>` (tên kebab-case như `per-ip-cap`), tạo issue với label `livespec` và `livespec:phase/shape`. Sau đó agent phỏng vấn bạn bằng skill `interview-me`. **Trả lời câu hỏi ngay trong chat**: phạm vi, người dùng, edge case, những gì nằm ngoài phạm vi. Nếu việc quá lớn cho một change, card gợi ý dùng initiative ([Luồng 3](#luồng-3-initiative-gồm-nhiều-change)).

Shape gate là `self` gate: khi agent chạy `spec_gate shape` và các check pass, change chuyển sang `define` mà không hỏi bạn.

### 2. Tạo branch

Khi change đã qua `shape`, card ghi `Run change_start #<n>`. Agent fetch integration branch và tạo `livespec/<name>` từ đó, ghi `Branch` và `Base` vào issue. Agent không bao giờ push. Hãy bắt đầu với working tree sạch.

### 3. Define: proposal và spec

Agent dùng `spec_write` để viết `Capabilities`, `Product impact`, `Proposal` và `Design` của issue, và sửa `specs/<capability>/spec.md` trên branch (requirement dùng SHALL/MUST và scenario dạng WHEN/THEN). Một spec reviewer có thể chạy để góp ý. Khi các check pass, agent request **define gate**: xem [Define gate](#define-gate-hành-vi-này-có-đúng-không).

Câu hỏi agent không tự trả lời được sẽ thành request `spec_question` ([Câu hỏi](#câu-hỏi-trả-lời-điều-agent-không-thể-biết)). Một câu hỏi blocking giữ mọi gate đóng cho đến khi bạn trả lời.

### 4. Plan: các unit

Agent viết mục `## Units` bằng `plan_units`. Mỗi unit trông như sau:

```markdown
### U3 — Rate limit per IP
Covers: rate-limit/Requirement: Per-IP cap
Difficulty: medium
Tags: [security, api]
Files: src/middleware/ratelimit.ts, test/ratelimit.test.ts
Done means:
- [cap] the 101st request within 60 s from one IP gets 429
Scenarios:
- [cap] test/ratelimit.test.ts › rejects 101st request
Depends: U1
Verify: `bun test ratelimit`
- [ ] pending
```

`Difficulty` và `Tags` do rule đặt, không phải agent. Trước gate, livespec chạy `Verify` của mọi unit trên `Base` trong một worktree tạm (`verify-red-on-base`): unit thường phải fail ở đó, chứng tỏ test kiểm tra điều gì đó mới. Sau đó nó request **plan gate**: xem [Plan gate](#plan-gate-cách-build-này-có-đúng-không). Khi được duyệt, digest của từng unit bị **khóa**; sửa unit về sau cần `unit_amend` và sự đồng ý của bạn.

### 5. Build: từng unit một

Với mỗi unit sẵn sàng, card ghi `Build U<n>`. Vòng lặp là:

1. `unit_start U<n>` kiểm tra tree sạch và dependency đã xong, chạy `Verify` và ghi receipt `unit-start`. `Verify` phải **đỏ** (fail).
2. Agent (hoặc child implementer) viết test và code trong phạm vi `Files` của unit rồi commit.
3. `unit_finish U<n>` chạy lại `Verify`. Khi **xanh** (pass), livespec ghi receipt có cả hai SHA và exit code, rồi tick unit.

Bạn không cần làm gì ở đây, trừ khi có thứ chờ bạn:

- **Một lần thử thất bại** được đếm. Sau `loops.unit_attempts` (3) lần thất bại, hoặc hai lần thất bại giống hệt nhau liên tiếp, unit bị `BLOCKED` và agent gửi **stuck report** ([Stuck report](#stuck-report-chọn-lối-ra)).
- **Unit cần thay đổi** (sai `Files`, thiếu scenario) → agent gọi `unit_amend`, gửi bạn request **amendment**, trả lời giống plan gate.
- **Agent cần làm việc ngoài change** → [Luồng 4](#luồng-4-phát-hiện-dependency-giữa-lúc-build).

Khi session định kết thúc trong lúc còn unit đang dở hoặc tree bẩn, livespec yêu cầu agent tiếp tục một lần, rồi ghi một comment `incomplete` lên issue.

### 6. Review

Agent chạy `spec_review`. Tool này chạy mọi `Verify` tại `HEAD`, khởi chạy reviewer (reviewer toàn change luôn chạy; các persona security, performance và test chạy theo tag), gộp finding, gửi finding sang verifier, rồi định tuyến từng finding:

- finding nằm trong `Files` của một unit sẽ untick unit đó và đưa change về `build`;
- finding cần bạn quyết định trở thành câu hỏi;
- finding ngoài phạm vi không bao giờ chặn; nó được liệt kê cho bạn ở ship gate dưới dạng follow-up;
- hạ chuẩn (thêm `skip`/`only`, `@ts-ignore`, xóa test) luôn là CRITICAL.

Review gate là `self`: pass khi vòng review gần nhất chạy tại `HEAD` hiện tại và không còn finding chặn. Sau `loops.review_rounds` (3) vòng vẫn còn finding chặn, một stuck report sẽ đến với bạn.

### 7. Ship

Agent điền bảng `## Durable docs` bằng `docs_table` (file nào trong `spec.md`, `product.md`, `glossary.md`, `constraints.md`, `decisions/` đã được cập nhật, và lý do các file còn lại không cần), rồi request **ship gate**: xem [Ship gate](#ship-gate-đã-sẵn-sàng-publish-chưa).

Sau khi bạn duyệt, agent chạy `change_ship`. Tool này push commit đã review và mở một pull request ghi `Refs #<issue>`. Nó không bao giờ viết closing keyword, nên forge không tự đóng issue khi merge.

**Feedback trên pull request.** Review comment của người có quyền write và CI check fail được tự động kéo về khi bắt đầu session và khi chạy `/livespec next`. Chúng đưa change về `review`; agent sửa trên cùng branch, review gate pass lại, và `change_push` cập nhật pull request. Nếu bản sửa chạm vào `specs/`, ship gate được hỏi lại.

### 8. Close

**Bạn merge pull request trên forge.** livespec không bao giờ merge. Ở lần refresh tiếp theo, card ghi chuyển sang `close`, và agent chạy `change_close`: đăng bản tóm tắt, tick change trong initiative (nếu có) và đóng issue.

Để bỏ change, hãy đóng pull request mà không merge, rồi bảo agent chạy `change_close --abandon <reason>`. (Change bị bỏ qua lựa chọn D của [Luồng 4](#luồng-4-phát-hiện-dependency-giữa-lúc-build) có thể abandon mà không cần pull request.)

## Human gate: đọc gì và trả lời thế nào

Mọi quyết định của con người đi theo cùng một vòng đời: agent hỏi, **bạn** trả lời, livespec ghi kết quả lên issue. Agent không thể trả lời thay bạn; tin nhắn của agent ghi "approved" không thay đổi gì cả.

### Request hiện ở đâu

| Adapter | Dùng khi | Bạn thấy gì | Cách trả lời |
|---|---|---|---|
| `in-session` (mặc định) | pi có UI (`hasUI`) | một dialog cho mỗi request trong pi TUI; select prompt ở RPC host và các mode khác | chọn một option rồi gửi ở **Review**; Esc được tính là **dismiss** |
| `forge` | forge đã kết nối và ghi được | comment `request` trên change issue | đăng một comment mới có **dòng đầu tiên** là lệnh `/livespec …` |

Chọn thứ tự trong `interaction.adapter` (ví dụ `[in-session, forge]`: dialog khi bạn đang ngồi ở bàn phím, issue khi không, và khi ở print mode). `/livespec doctor` cho biết adapter nào sẽ trả lời lúc này.

### Trả lời trong session

Tiêu đề dialog là tóm tắt request (các fact), rồi đến briefing (xem [Briefing và đề xuất](#briefing-và-đề-xuất)). Mỗi entry của menu có dạng `<label> — <description>`; entry được đề xuất đứng đầu và kết thúc bằng ` (Recommended)`. Với gate, menu gồm:

1. **approve** (bị ẩn khi có waivable check đang fail; lúc đó dùng `waive`);
2. **request changes**, rồi gõ những gì cần đổi;
3. **dismiss**;
4. các option bổ sung, ví dụ `waive`, kèm mô tả.

Câu hỏi hiển thị 2 đến 4 đáp án ứng viên, **write my own answer** và **answer later (non-blocking)**. Chọn một ứng viên là trả lời bằng label của nó.

Trong pi TUI, request là một dialog với các tab **Decision** và **Review**. **Adjust units** mở bằng `u` ở Decision, ở plan gate và với amendment, khi unit có thể override. Ghi note bên trong bằng `n`; không gì được gửi cho đến khi bạn gửi ở **Review**. **answer later** và **dismiss** đóng dialog ngay, không qua Review.

Ở RPC host và các mode khác, cùng các câu trả lời đó đến từ select prompt: sau approve hoặc một option, bạn chọn **No notes** hoặc **Add notes**; ở plan gate và với amendment là **Keep classification** hoặc **Adjust Difficulty or Tags**.

**Phím trong dialog** (TUI):

- `↑` `↓` di chuyển; `1`–`9` chọn entry có số đó.
- `n` ghi note.
- `u` mở **Adjust units** (Decision, khi unit có thể override).
- `Tab` / `Shift+Tab` tab kế tiếp / trước.
- `←` / `→` đổi Difficulty; `e` sửa tags (Adjust units).
- `PgUp` / `PgDn` cuộn fact và briefing.
- `Enter` chọn (Decision), sang tab kế (Adjust units), gửi (Review); khi editor đang mở, lưu nó.
- `Esc` hủy request (`dismissed`); khi editor đang mở, chỉ đóng editor.

### Briefing và đề xuất

Mỗi request cần con người đều kèm một **briefing** bên cạnh các fact: tóm tắt ngắn, tối đa năm điểm cần để ý, lựa chọn được đề xuất và lý do. Hãy đọc nó như lời khuyên, không phải bằng chứng:

- **Fact đứng trước.** Tóm tắt, file, link và check fail do livespec viết. Briefing theo sau, gắn nhãn `Agent recommendation (agent-authored, advisory)`. Rule hỏi (`decide:`) mang briefing do rule viết, gắn nhãn `Livespec rule recommendation`.
- **Đề xuất không phải câu trả lời.** Nó chỉ đánh dấu một lựa chọn (đứng đầu menu, `(recommended)` trên forge). Không có gì được duyệt cho đến khi bạn chọn. Đề xuất phải trỏ tới lựa chọn thực sự được đưa ra: `approve` không bao giờ được đề xuất khi còn check phải waive.
- **Text của agent là vô hại.** livespec vô hiệu hóa `<!--` và `/livespec` ở đầu dòng trong đó, nên briefing không thể thêm lệnh hay giả marker.
- Request tạo trước tính năng này không có briefing và vẫn hoạt động.

`spec_gate` bắt buộc có briefing cho gate của con người hoặc gate bị escalate; `unit_amend`, `initiative_propose` và `new_dependency` cũng bắt buộc có briefing. Mỗi briefing cần lựa chọn `recommended` và `rationale`. `spec_question` cần 2 đến 4 candidate kèm `recommended` và `rationale`.

### Trả lời trên forge

Đọc comment `request`. Bố cục từ trên xuống: heading **Decision needed**, các fact (tóm tắt, file, link), bảng waivable check đang fail, briefing dạng blockquote, bảng **How to answer** (lựa chọn, điều xảy ra, lệnh chính xác; lựa chọn được đề xuất in đậm kèm `(recommended)`) và danh sách **All accepted commands** thu gọn. Ví dụ (plan gate có `size-limits` fail):

```markdown
## Decision needed: approve the plan gate on #7

### Review (blocking)

Plan: 9 units, 3 capabilities.

### Failing checks

These waivable checks fail; approving needs `waive`.

| Check |
| --- |
| `size-limits` |

### Agent recommendation (agent-authored, advisory)

> Units are small and each has one Verify command.
>
> Recommended: Waive size-limits
>
> Rationale: the split would not make the units smaller.

### How to answer

Post a new comment whose first line is the command (write access required).

| Choice | What happens | Command |
| --- | --- | --- |
| **Waive size-limits** (recommended) | Approve and waive the failing checks: size-limits. | `/livespec choose waive [notes]` |
| request changes | Send the request back with notes; nothing is approved. | `/livespec changes <notes>` |
| dismiss | Close the request without approving it. | `/livespec dismiss [notes]` |
```

Bảng của câu hỏi liệt kê từng ứng viên với lệnh `/livespec answer Q<n> <label>` và một dòng cho câu trả lời riêng của bạn. Trả lời bằng một comment **mới** (sửa comment cũ không có tác dụng):

| Lệnh | Dùng để |
|---|---|
| `/livespec approve [notes]` | duyệt gate hoặc amendment (notes tùy chọn) |
| `/livespec changes <notes>` | yêu cầu sửa; bắt buộc có notes |
| `/livespec dismiss [notes]` | từ chối mà không quyết định; agent phải hỏi bạn cách tiếp tục |
| `/livespec choose <option-id> [notes]` | chọn option: `waive`, option của stuck report, `A`/`B`/…, `unchanged`/`changed` |
| `/livespec answer Q<n> <text>` | trả lời câu hỏi trong một bước; muốn đổi requirement thì sửa spec |
| `/livespec set U<n> difficulty <low\|medium\|high>` | override một unit (plan gate và amendment; chỉ áp dụng nếu gate được duyệt) |
| `/livespec set U<n> tags <a,b,…>` | override tag của unit (tương tự) |

Các quy tắc quyết định comment của bạn có được tính không:

- **Chỉ tài khoản có quyền `write` hoặc `admin`** trên repository mới trả lời được.
- Comment phải **mới hơn request**; lệnh đăng trước request bị bỏ qua.
- `approve`, `changes` và `choose` nhắm vào **duy nhất một** gate hoặc amendment đang chờ (nếu không có thì nhắm vào stuck hoặc decide request duy nhất đang chờ). Nếu có nhiều request đang chờ và không rõ nhắm vào cái nào, comment bị bỏ qua.
- Lệnh đã bị bỏ qua thì luôn bị bỏ qua; phase card cho biết lý do. Hãy đăng một comment đã sửa.
- Câu trả lời được lấy về khi bắt đầu session, khi chạy `/livespec next` và trước mỗi tool của livespec. Nếu không có session nào chạy, session kế tiếp sẽ áp dụng chúng.

### Điều gì xảy ra sau khi bạn trả lời

| Câu trả lời | Kết quả |
|---|---|
| approve / approve kèm notes | một comment `gate` được ghi; change chuyển sang phase tiếp theo (trừ `ship`: change ở lại và cho phép `change_ship`) |
| request changes | phase giữ nguyên; các phase sau bị đánh dấu stale; agent sửa và hỏi lại |
| dismiss | không có gì thay đổi; agent hỏi bạn trong chat cách tiếp tục |

**Một approval có thể bị superseded.** Khi ghi nhận câu trả lời, livespec kiểm tra những gì bạn đã thấy vẫn còn đúng: `HEAD` không đổi, body issue không đổi, tree sạch và không có điều kiện từ chối nào. Nếu có gì thay đổi (commit mới, sửa proposal trên web, file chưa commit), câu trả lời được ghi là `superseded`, không có gì tiến lên, và agent phải request gate lại. Chỉ duyệt đúng thứ bạn đã review, và đừng push hay sửa issue giữa lúc có request và lúc bạn trả lời.

### Define gate: hành vi này có đúng không?

**Bạn thấy:** dòng `Capabilities`, dòng `Product impact`, Proposal (hoặc phần đầu kèm link), danh sách và thống kê các file thay đổi dưới `specs/`, cùng các cảnh báo glossary và các mục glossary mà diff thêm vào.

**Cần đọc:**

1. **Proposal** trên issue: vấn đề và phạm vi có đúng điều bạn yêu cầu không? Có gì thiếu hay vượt phạm vi?
2. **Spec diff** (`git diff <Base>..HEAD -- specs/` trên branch): mỗi requirement phải kiểm thử được, mỗi scenario là một cặp WHEN/THEN cụ thể. Các scenario này sẽ thành test.
3. **Capabilities**: tên new và modified khớp với diff.
4. **Product impact**: `updated` hoặc `none — <reason>`. Một capability mới mà ghi `none` là sai.
5. **Glossary**: thuật ngữ mới đã được định nghĩa; duyệt gate nghĩa là duyệt luôn các mục glossary được liệt kê.

**Trả lời:** approve khi spec nói đúng chính xác điều cần build. Nếu không, request changes với notes cụ thể, ví dụ `/livespec changes split "Per-IP cap" into burst and sustained limits; add a scenario for IPv6`.

**Kết luận behavior.** Với mỗi capability có code thay đổi dưới `paths` mà không sửa spec, agent đưa ra kết luận tại `spec_gate define` hoặc `spec_gate review` về việc hành vi có đổi không, kèm lý do một dòng. Gate liệt kê chúng dưới "Behavior conclusions (please check)". Nếu `changed`, gate sẽ từ chối cho đến khi spec được cập nhật. Để không đồng ý, request changes và đánh dấu capability là changed: nhấn `b` (tab Behavior) trong dialog pi, hoặc dùng "Mark behavior changed" ở select fallback. Override chỉ có trong session; forge không có lệnh override. Các kết luận là ledger entry; override của human chỉ có hiệu lực khi đi kèm comment `answer` trên forge của gate request tương ứng.

### Plan gate: cách build này có đúng không?

**Bạn thấy:** id, tiêu đề, `Difficulty`, `Tags` và `Covers` của từng unit, lý do của mỗi quyết định phân loại, các tag agent thêm vào, và kết quả `verify-red-on-base`.

**Gate:** `self` mặc định: agent tự pass gate khi các check pass, trừ khi rule `gate-escalation` hỏi bạn. Nó hỏi khi một waivable check fail (ví dụ `size-limits`), advisory plan review tại `HEAD` thiếu hoặc có finding CRITICAL, hoặc một unit có tag `security` hoặc `migration`. Request kết thúc bằng `Escalated: <reason>` và bắt buộc có briefing. Muốn luôn hỏi, đặt `gate: human` cho phase `plan` trong `.pi/livespec/flow.yaml` (kèm `extends: agent-skills`); muốn đổi trigger, đặt `decisions.gate-escalation` (`phases`, `tags`).

**Cần đọc:**

1. **Độ phủ**: mọi requirement và scenario từ define đều được một unit nào đó phủ (`Covers`, `Scenarios`).
2. **Verify** của từng unit: một lệnh chạy test của unit, hôm nay đỏ và xanh khi xong. Lỗi red-on-base nghĩa là test đã pass sẵn; hãy hỏi vì sao.
3. **Files**: nhỏ và cụ thể. `change_ship` từ chối diff có file nằm ngoài `Files` của mọi unit (và ngoài `specs/`), và một lane đi lạc sẽ chạy lại tuần tự.
4. **Depends** và thứ tự: các unit có thể chạy song song không dùng chung `Files`.
5. **Difficulty và Tags**: tag quyết định reviewer nào chạy (`security` thêm security auditor). Override nếu thấy sai.
6. **Kích thước**: quá 8 unit hoặc 3 capability sẽ làm `size-limits` fail. Hoặc bảo agent tách (`change_split`), hoặc chủ động `choose waive`.

**Trả lời:** approve để khóa plan. Override bằng `/livespec set U3 difficulty high`, bằng `u` (Adjust units) trong pi TUI, hoặc bước "Adjust Difficulty or Tags", rồi approve. Request changes khi thiếu độ phủ hoặc `Verify` không tốt.

### Ship gate: đã sẵn sàng publish chưa?

**Bạn thấy:** bảng `## Durable docs`, và kết quả review: finding bị tranh chấp kèm lý do của verifier, finding đã bị phản bác, follow-up ngoài phạm vi, và các review subject chạy inline (không có child độc lập nào kiểm tra).

**Cần đọc:**

1. **Durable docs**: mỗi dòng `updated` ghi một file có trong diff; mỗi dòng `not needed` có lý do mà bạn đồng ý.
2. **Finding bị tranh chấp và bị phản bác**: bạn là người phân xử. Nếu bạn đứng về phía reviewer, hãy request changes.
3. **Follow-up**: tạo issue cho các finding ngoài phạm vi mà bạn muốn giữ.
4. **Bản thân diff** trên branch, vì pull request chưa tồn tại.

**Trả lời:** approve, rồi bảo agent ship. Approval gắn với `HEAD` đã review; một commit sau đó (trừ clean merge của integration branch) cần review lại.

### Câu hỏi: trả lời điều agent không thể biết

**Bạn thấy:** nội dung câu hỏi và việc nó có chặn hay không: `blocking` (gate giữ đóng) hoặc `non-blocking` (sau khi bạn chọn **answer later** trong session), và 2 đến 4 **đáp án ứng viên** (mỗi cái có label và mô tả), một cái được đề xuất kèm lý do.

**Trả lời** bằng cách chọn một ứng viên hoặc gõ text riêng. Một bước là đủ:

```text
/livespec answer Q2 use per-user limits, not per-IP
```

Nếu đáp án làm đổi một requirement, hãy tự sửa `specs/<capability>/spec.md` và commit trên branch của change; không có flag nào. Cascade dưới đây chỉ chạy sau khi plan đã được lock; trước đó, thay đổi chỉ là một phần của change. livespec phát hiện thay đổi từ spec diff khi bắt đầu session, khi chạy `/livespec next`, và trước gate kế tiếp hoặc `unit_finish`. Change quay về `define` và các unit đã xong phủ requirement đó bị untick; bộ đếm `change_iterations` tăng nếu plan đã được duyệt. Chỉ sửa spec khi đáp án thực sự đổi nó. Chọn "Answer later" trong session làm câu hỏi thành non-blocking và chuyển nó sang adapter kế tiếp. Với chain không có adapter in-session, câu hỏi vẫn blocking cho đến khi được trả lời: answer later chỉ có trong session (sửa marker `(blocking)` trên issue vẫn được tính).

### Stuck report: chọn lối ra

**Bạn thấy:** comment `stuck` gồm việc dừng ở đâu, đã thử những gì (kèm link), một giả thuyết, hai hoặc ba option kèm mô tả, và option được đề xuất kèm lý do (agent bắt buộc phải cung cấp cả hai).

**Trả lời:** chọn một option (`/livespec choose B`, hoặc chọn trong dialog). Một lựa chọn sẽ reset ngân sách bị chặn (số lần thử unit, số vòng review hoặc số iteration). **Dismiss không gỡ giới hạn**; agent sẽ phải hỏi lại.

### Amendment, decision và các named gate khác

- **Amendment (`amend:<n>`):** agent muốn sửa, thêm hoặc bỏ một unit đã khóa. Đọc unit cũ và mới; trả lời như plan gate.
- **Decision (`decide:<point>.<subject>`):** một rule không tự quyết được. Không rule built-in nào hỏi; rule của project hoặc pack có thể hỏi. Chọn một trong các option được liệt kê.
- **`initiative` và `new-dependency`:** xem [Luồng 3](#luồng-3-initiative-gồm-nhiều-change) và [Luồng 4](#luồng-4-phát-hiện-dependency-giữa-lúc-build).

## Luồng 2: sửa lỗi nhỏ

Dùng cho lỗi chính tả, bug nhỏ khôi phục hành vi đã có trong spec, hoặc refactor rất nhỏ. Không có issue, gate hay unit.

1. **Bắt đầu:** bảo agent bắt đầu một fix, ví dụ "sửa lỗi chính tả trong README theo dạng small fix". Agent chạy `fix_start <slug>` từ tree sạch trên integration branch, tạo `fix/<slug>`. (Branch bạn tự tạo với tên đó cũng được tính.)
2. **Sửa:** agent sửa code, test và, nếu cần, living spec, rồi commit.
3. **Kiểm tra lane:** card hiển thị kết quả lane sau mỗi commit. Fix phải giữ ở mức **small**: tối đa 3 file và 100 dòng thay đổi, không thêm hay bỏ requirement hoặc scenario, không tạo capability mới, không sửa `specs/constraints.md` hay `specs/decisions/`.
4. **Ship:** agent chạy `fix_ship`. Tool này chạy `testCommand`, từ chối nếu lệnh không exit 0, push `fix/<slug>` và mở (hoặc cập nhật) một pull request kèm kết quả test và quyết định lane.
5. **Bạn review và merge** pull request trên forge.

**Khi fix vượt quá lane**, card báo nó buộc phải thành một change đầy đủ. Bảo agent chạy `change_new <name> --from-fix`: issue được tạo ở `define`, các commit được giữ, và branch được đổi tên thành `livespec/<name>`. Tiếp tục với [Luồng 1](#luồng-1-một-change-đầy-đủ) từ bước 3.

**Bare work.** Sửa file ngoài `specs/` trên branch không phải `livespec/*` hay `fix/*` vẫn được phép, nhưng livespec cảnh báo và ghi vào `specs/bare-work.md`.

## Luồng 3: initiative gồm nhiều change

Dùng khi một mục tiêu cần nhiều change được ship riêng và phụ thuộc lẫn nhau.

1. **Shape change đầu tiên** như bình thường. Khi số capability khai báo hoặc số unit dự thảo vượt giới hạn, card nêu `initiative_propose`. Bạn cũng có thể yêu cầu initiative trực tiếp.
2. **Agent đề xuất** initiative: tên, mục tiêu, các capability, và danh sách change kèm proposal ngắn và `Depends` của từng cái. Việc này gửi **`initiative` gate**. Chưa có gì được tạo.
3. **Bạn review đề xuất.** Cần đọc:
   - mỗi change có ship và review độc lập được không?
   - `Depends` có đúng không, không change nào chờ thứ nó không cần?
   - change hiện tại có nằm đúng vị trí trong danh sách không?

   Approve, hoặc request changes kèm notes. Vòng phụ thuộc và tên trùng bị từ chối trước khi đến tay bạn.
4. **Khi được duyệt**, livespec tạo tracking issue (label `livespec:initiative`), các change issue mới ở `shape`, và liên kết change hiện tại.
5. **Làm từng change** theo [Luồng 1](#luồng-1-một-change-đầy-đủ). Card hiển thị tiến độ của initiative và các change sẵn sàng bắt đầu. Change có dependency chưa merge hiện "waits for #A"; khi nó merge, **bạn bảo agent** chạy `change_start #N`.
6. **Giữ branch cập nhật.** Khi một change anh em được merge, card yêu cầu `change_sync`: merge integration branch, chạy lại `Verify` của mọi unit đã xong và untick các unit bị hồi quy hoặc có requirement bị change anh em thay đổi.
7. **Đóng change cuối cùng** sẽ đóng initiative kèm bản tóm tắt.

Để thêm, sửa hoặc bỏ change về sau, bảo agent amend initiative; cùng `initiative` gate đó sẽ đến với bạn. Để chuyển các unit đang chờ của một change quá lớn sang change mới: `change_split #N --units U5,U6 --into <name>`.

## Luồng 4: phát hiện dependency giữa lúc build

Khi implementer báo một unit cần việc nằm ngoài change (`missing-prerequisite`), card nêu `new_dependency`. Agent soạn các option và gửi **`new-dependency` gate**:

| Option | Chọn khi | Tiếp theo |
|---|---|---|
| **A** | phần tiên quyết đáng là một change riêng | tạo change mới ở `shape`; change này bị **park** |
| **B** | phần thiếu nhỏ và thuộc về change này | thêm unit qua `unit_amend --add` |
| **C** | có thể làm stub trước | một unit stub ở đây và một change follow-up |
| **D** | change này sai hướng | quay về `shape`, hoặc bỏ change |
| **split** | một số unit đã xong | ship các unit đã xong; phần còn lại sang change mới |

Đọc phần tiên quyết được soạn (tên, proposal) và trả lời bằng `/livespec choose A` (hoặc chọn trong dialog).

**Sau khi chọn A:**

1. Agent chạy `change_park`: công việc đang dở được commit vào wip branch, push qua livespec, các lane được đóng, và issue nhận label `livespec:parked`. Gate từ chối trong lúc park.
2. Build và merge change tiên quyết.
3. Khi card báo dependency đã merge, **bạn bảo agent** chạy `change_resume #N`. Tool này sync với integration branch, merge lại các wip branch, xóa chúng trên remote và gỡ trạng thái park.

Sau hai dependency đã được duyệt (`loops.discovered_deps`), dependency tiếp theo sẽ thành stuck report.

## Luồng 5: drift audit

Chạy định kỳ, hoặc khi mục **Audit** trên card báo có commit được đưa vào ngoài livespec.

1. Chạy `/livespec audit` (hoặc `/livespec audit #T` để đăng lên initiative `#T`). Lệnh đọc `origin/<integration>`, không sửa file nào và không tạo gì ngoài một comment `drift-report`.
2. Đọc báo cáo. Mỗi mục là `major` (hướng xử lý: một change đầy đủ) hoặc `minor` (hướng xử lý: small fix): scenario chưa có test, tham chiếu tới code đã xóa, glob `paths` chết, thuật ngữ glossary không dùng, decision cũ, capability thiếu trong `product.md`, và các fix khai báo không đổi hành vi.
3. Phân loại trên initiative bằng một comment cho mỗi mục: `/livespec triage <key> major|minor|ignore`. Lần audit sau sẽ áp dụng.
4. Sửa các mục bằng [Luồng 2](#luồng-2-sửa-lỗi-nhỏ) hoặc [Luồng 1](#luồng-1-một-change-đầy-đủ).

## Chuyển từ OpenSpec

1. Hoàn tất hoặc archive các OpenSpec change đang mở trước; chỉ living spec được chuyển.
2. Trên integration branch với tree sạch, chạy `/livespec migrate-openspec`. Lệnh `git mv` từng `openspec/specs/<cap>/spec.md` sang `specs/<cap>/spec.md` mà không đổi nội dung. Không có gì khác dưới `openspec/` bị di chuyển. Lệnh từ chối, không di chuyển gì, nếu có bất kỳ file đích nào đã tồn tại.
3. Chạy `/livespec init` để tạo các file còn thiếu, rồi `/livespec validate`.
4. Commit. Tự xóa `openspec/` khi không còn cần lịch sử của nó, và tắt pi-superspec hoặc Superpowers cho project.

## Tùy chọn: subagent và parallel lane

livespec có thể giao việc theo role (`scout`, `implementer`, `reviewer`, `verifier`) cho subagent child và chạy các unit độc lập trong parallel lane. Session cha giữ toàn bộ state, bằng chứng, việc ghi forge và gate. Khi không có executor, mọi role chạy inline (`subagent_packet` / `subagent_record`) và để lại cùng bằng chứng. Xem [Architecture: Subagents](docs/architecture.md#subagents) (tiếng Anh).

**Cài executor**, sau đó tùy chọn cài định tuyến model Jev:

```sh
pi install git:github.com/ttdua/pi-subagents@v0.1.1
pi install git:github.com/ttdua/pi-jev-pilot   # 0.6.0 trở lên, cài sau executor
```

livespec nhận diện executor theo khả năng (`spawn`, `wait`, `resume`, `abort`, `childSession`, `getAgentType`), không bao giờ theo tên package. `/livespec doctor` báo executor, khả năng còn thiếu và role agent bị override.

- **Model và effort.** livespec không bao giờ đặt model. Nó yêu cầu thinking level theo `Difficulty` của unit, tăng một mức sau mỗi lần thử thất bại. Có Jev thì pi-jev-pilot định tuyến model; không có thì agent file của role và setting pi của bạn quyết định. Mỗi record `dispatch` lưu những gì được yêu cầu và những gì thực sự chạy.
- **Gợi ý cho role.** Dùng model mạnh cho `reviewer` và `verifier`: finding của chúng chặn `unit_finish`. `scout` chỉ đọc, nên model rẻ là đủ. Override một role bằng agent file cùng tên, ví dụ `~/.pi/agent/agents/reviewer.md`.
- **Lane.** Các unit sẵn sàng, không có `Depends` lẫn nhau và `Files` tách biệt, chạy trong worktree `.worktrees/<change>--<unit>` (`lane_open`), tối đa `lanes` (3). `lane_merge` merge từng lane về và chạy lại `Verify`. Lane đụng vào file ngoài unit của nó sẽ chạy lại tuần tự.
- **Finding.** Một review finding chặn sẽ khiến `unit_finish` từ chối cho đến khi được sửa, bị phản bác bằng `finding_rebut` hoặc, với `needs-decision`, được trả lời. Finding ngoài phạm vi không bao giờ chặn; chúng được liệt kê ở human gate kế tiếp.
- **Workspace provider.** `@gotgenes/pi-subagents-worktrees` di chuyển child ra khỏi lane của nó. Xóa `npm:@gotgenes/pi-subagents-worktrees` khỏi setting pi để giữ lane chạy song song; doctor cảnh báo khi nó còn được cấu hình.
- **Giới hạn đã biết.** Khi không có executor, `/fork` hoặc `/clone` của session chính bị coi là child: không có phase card, và các tool subagent và lane từ chối ở đó.

## Tham khảo

### Lệnh

| Lệnh | Tác dụng |
|---|---|
| `/livespec` | in version đã cài |
| `/livespec init` | tạo các file khởi đầu còn thiếu và clone agent-skills |
| `/livespec doctor` | kiểm tra pack, config, clone, tài khoản forge, approver chain, executor |
| `/livespec validate` | validate `specs/` |
| `/livespec next` | lấy câu trả lời và in bước tiếp theo |
| `/livespec account [name]` | xem hoặc đổi tài khoản forge của clone này |
| `/livespec skills status\|update\|pin <sha>\|unpin\|rollback` | quản lý clone agent-skills |
| `/livespec audit [#T]` | drift audit chỉ đọc trên integration branch |
| `/livespec migrate-openspec` | chuyển `openspec/specs/*/spec.md` sang `specs/` |

### Tool của agent

Bạn hiếm khi tự gọi các tool này; đây là những gì phase card nêu tên.

| Nhóm | Tool |
|---|---|
| State | `spec_status`, `spec_next`, `spec_validate`, `forge_read` |
| Change | `change_new`, `change_start`, `spec_write`, `change_split`, `change_sync`, `change_park`, `change_resume`, `change_ship`, `change_push`, `change_close` |
| Request tới con người | `spec_gate`, `spec_question`, `spec_stuck`, `unit_amend`, `initiative_propose`, `new_dependency` |
| Build | `plan_units`, `unit_start`, `unit_finish` |
| Review và ship | `spec_review`, `finding_rebut`, `docs_table` |
| Small fix | `fix_start`, `fix_ship` |
| Subagent | `subagent_dispatch`, `subagent_answer`, `subagent_packet`, `subagent_record`, `lane_open`, `lane_merge` |

### Cấu hình

Config project: `.pi/livespec/config.yaml`. Config user: `~/.pi/agent/livespec/config.yaml`. Key lạ và giá trị không hợp lệ chỉ là cảnh báo; giá trị mặc định được dùng.

| Key | File | Mặc định | Ý nghĩa |
|---|---|---|---|
| `forge` | project | từ `origin` | `github` hoặc `gitea` |
| `host`, `githubHosts`, `giteaUrl` | project | — | host của forge tự host |
| `integrationBranch` | project | default branch của forge | branch mà change tạo ra từ đó và merge vào |
| `testCommand` | project | — | lệnh `fix_ship` chạy; bắt buộc cho small-fix lane |
| `verify.setup` | project | symlink `node_modules`, `.venv`, `vendor` | lệnh chuẩn bị worktree tạm cho Verify |
| `verify.timeout` | project | `600` | số giây cho mỗi lần chạy Verify |
| `interaction.adapter` | project, rồi user | `[in-session]` | approver chain theo thứ tự: `in-session`, `forge` |
| `agentSkills.channel` | chỉ user | `auto` | cập nhật agent-skills theo `auto`, `notify` hoặc `pinned` |
| `ledger.retain` | project | `true` | giữ ledger của change (`refs/livespec/<issue>`) sau `change_close`; `false` xóa ledger ở local và trên `origin` (close bằng `--abandon` giữ lại ledger) |
| `lanes` | user | `3` | số lane song song tối đa |
| `packetBudgetTokens` | user | `24000` | kích thước packet trước khi nguồn được tách ra file |
| `isolation.excludePackages` | user | `[]` | các package pi không nạp trong child của livespec |

Flow pack đi kèm tại `src/packs/agent-skills.yaml`. Project có thể mở rộng hoặc thay thế nó bằng `.pi/livespec/flow.yaml` (giới hạn vòng lặp, limit, path và keyword của tag, ngưỡng lane, chính sách subagent). Pack không hợp lệ sẽ dừng livespec và doctor liệt kê lỗi.

### File trong repository của bạn

```text
specs/
├── product.md                 # mô hình tư duy và các luồng chính
├── glossary.md                # thuật ngữ chung
├── constraints.md             # chuẩn chất lượng
├── decisions/NNNN-<slug>.md   # decision record
├── bare-work.md               # nhật ký việc làm ngoài mọi change
└── <capability>/spec.md       # living spec, sửa trực tiếp
.pi/livespec/config.yaml       # config project
.pi/livespec/flow.yaml         # override flow pack, tùy chọn
```

Agent không thể ghi vào `.pi/livespec/`; bạn tự sửa. Cache cục bộ (`~/.pi/agent/livespec/`, `<git common dir>/livespec/`) có thể xóa an toàn.

## Xử lý sự cố

| Triệu chứng | Nguyên nhân và cách xử lý |
|---|---|
| Không có phase card | project chưa khởi tạo (`/livespec init`, `/reload`), hoặc branch không phải `livespec/*`/`fix/*` và không xác định được change: `/livespec next` liệt kê các change đang mở |
| `livespec guard:` chặn một lệnh | agent đã thử `git push`, ghi bằng `gh`/`tea` hoặc sửa `.pi/livespec/`. Lý do nêu tên tool livespec cần dùng thay thế |
| Request gate bị từ chối | đọc lý do: câu hỏi blocking đang mở, stuck report chưa trả lời, request đang chờ, tree bẩn, change đang park hoặc một check fail. Xử lý điều đó trước |
| `spec_gate` từ chối và nêu `interaction.adapter` | không có adapter nào khả dụng: ở print mode hãy thêm `forge` vào chain |
| `/livespec approve` của tôi không có tác dụng | comment được đăng trước request, bởi tài khoản không có quyền write, bị mơ hồ, hoặc dùng `approve` khi có waivable check fail (`choose waive`). Card hiển thị lý do |
| Approval bị ghi là `superseded` | `HEAD`, body issue hoặc tree đã thay đổi sau request. Bảo agent request gate lại |
| Ghi forge bị chặn / chế độ read-only | doctor cho biết trạng thái tài khoản. Đăng nhập bằng `gh`/`tea`, hoặc đổi bằng `/livespec account <name>` |
| Unit bị `BLOCKED` | đã hết số lần thử; hãy trả lời stuck report |

## Tài liệu

Các tài liệu dưới đây hiện chỉ có tiếng Anh.

- [Project brief](docs/project-brief.md): ý định, mục tiêu, non-goal và ràng buộc.
- [Architecture](docs/architecture.md): module, nơi lưu dữ liệu, luồng phase chi tiết.
- [Glossary](docs/glossary.md): từ vựng dùng trong spec và issue.
- [Roadmap](docs/roadmap.md): các spec theo thứ tự build, kèm issue.
- [Decisions](docs/decisions/): architecture decision record.

## Phát triển

Repository này được xây dựng bằng [pi-superspec](https://github.com/ttdua/pi-superspec):

- Mỗi spec trong roadmap là một GitHub issue, một OpenSpec change và một pull request. Issue đặt tên cho change.
- Để bắt đầu một spec, chạy `/opsx-new <change-name>` và dùng issue làm đầu vào cho brainstorming.
- Khi change được archive, hành vi nó xây dựng được ghi lại trong `openspec/specs/`.

Có hai loại thư mục spec, dễ nhầm lẫn:

- `openspec/` là hồ sơ phát triển của chính repository này, do pi-superspec quản lý.
- `specs/` là thư mục pi-livespec tạo ra trong các project *sử dụng* nó.

```sh
bun install
bun run test
bun run typecheck
```

Nội dung repository viết bằng tiếng Anh. `README.vi.md` là bản dịch của `README.md`: khi sửa `README.md`, hãy cập nhật bản dịch trong cùng pull request.

## Giấy phép

MIT. Xem [LICENSE](LICENSE).
