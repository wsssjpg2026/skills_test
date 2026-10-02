# 工业设备控制/编排软件现有方案与竞品格局（截至 2026-10）

> 调研时间：2026-10-02。GitHub 数据取自 GitHub API（2026-10-01/02 快照）。所有价格为第三方/经销商口径或厂商非公开报价口径，均已标注；标注"厂商宣称"处为利益相关方陈述。事实与观点分开：凡社区吐槽、厂商自称均以"观点/轶事"标注。

## Q1 各方案定位、核心能力、设备接入抽象（tag/点位模型）与编排范式

### Takeaway
三类方案分工清晰：商用 SCADA（Ignition/WinCC Unified/iFIX/组态王/力控）以"tag/点位 + 图形组态 + 脚本"为核心抽象；低代码 IoT 编排平台（Node-RED/ThingsBoard/Losant/Waylay）以"数据流/规则链"为核心抽象；工业连接中间件（Kepware/Matrikon）只做协议互转与点位映射、基本不做业务编排。行业编排范式正从"脚本+组态画面"向"可视化数据流 + 低代码规则链"迁移，"Node-RED 在边缘 + ThingsBoard 在中心"已成为常见组合模式。

### Cited Findings

**市场大盘（背景）**
- 2026 年全球 SCADA 市场规模各家估计约 $12–15B，CAGR 8.5–10%：Fortune Business Insights（$13.87B→2034 年 $26.59B，8.5%）、MarketsandMarkets（$13.94B→2032 年 $24.69B，10.0%）、Mordor Intelligence（$12.07B→2031 年 $18.58B，9.0%）— [Fortune Business Insights](https://www.fortunebusinessinsights.com/scada-market-102433)；[MarketsandMarkets](https://www.prnewswire.com/news-releases/scada-market-worth-24-69-billion-by-2032---exclusive-report-by-marketsandmarkets-302867459.html)；[Mordor](https://www.mordorintelligence.com/industry-reports/supervisory-control-and-data-acquisition-market)
- ARC Advisory Group 的 SCADA 市场研究（含量化预测与供应商排名）为付费内容，公开页仅列研究目录 — [ARC](https://www.arcweb.com/market-studies/scada-systems-market-data-studies)

**A. 商用 SCADA/组态软件**
- **Ignition（Inductive Automation）**：定位"工业集成平台"（SCADA/IIoT/MES/HMI），以模块化架构（基础平台 + 按需购买模块）和"无限授权"（unlimited tags/clients/users/devices/数据库连接，单服务器一口价）为核心差异化 — [Inductive Automation 定价页](https://inductiveautomation.com/pricing/edition)；[EZSoft](https://ezsoft-inc.com/scada-ignition)；[OperaMetrix 对比](https://www.operametrix.com/en/blog/ignition-vs-traditional-scada-comparison)。设备接入抽象为 tag/OPC，编排靠脚本 + 模块（此为产品文档通识，置信度：高）
- **WinCC Unified（西门子）**：运行时授权按 **PowerTags**（连接到 PLC/OPC UA 数据源的工艺变量）分档，最高档 60 万 PowerTags；归档/日志 tag（Logging Tags）单独按 100/500/1000/5000/10000/30000 档授权 — [Siemens Industry Mobile Support](https://www.industry-mobile-support.siemens-info.com/en/article/detail/109995683)；[SiePortal](https://sieportal.siemens.com/en-pk/products-services/10367281)。与 TIA Portal 深度绑定；小点位机器（如约 47 点）场景官方生态推荐直接用 MTP 面板而非 PC SCADA — [IndustrialMonitorDirect](https://industrialmonitordirect.com/blogs/knowledgebase/wincc-unified-powertags-reducing-tag-count-workarounds)
- **GE iFIX / Proficy（GE Vernova）**：按节点（per-node/per-server）+ tag 档位授权；iFIX 单节点约 $3,000–15,000+（视 tag 数），另有 CIMPLICITY（$6,000–50,000+/服务器）与按 tag 档计价的 Proficy Historian — [OperaMetrix 对比](https://www.operametrix.com/en/compare/ignition-vs-ge-ifix)；[MachineCDN](https://www.machinecdn.com/blog/machinecdn-vs-ge-ifix)；[GaugeHow](https://gaugehow.com/tools/ge-proficy)。GE 官方不公开报价，走分销商询价
- **组态王 KingView / KingSCADA（亚控科技）**：国产老牌，KingView 面向通用监控，KingSCADA 定位大型复杂工业监控（分布式架构、百万 IO、冗余）；正平台化转型为 KingFactory — [知乎 2026 横评](https://zhuanlan.zhihu.com/p/2031012311192822315)；[亚控官方新闻](https://www.kingview.com/news_info.php?num=1002846)（"SCADA 领域中国已与美、德、法并列全球四强"——厂商宣称）。组态王/力控/昆仑通态 MCGS 被归类为"设备绑定型"组态，核心逻辑"跟硬件走"（PLC/DCS/HMI）— [CSDN](https://bbs.csdn.net/weixin_30175731/article/details/100392544)
- **力控 ForceControl（力控科技）**：产品线覆盖更全，兼顾传统监控组态与 Web 路线，信创生态适配是突出卖点 — [知乎](https://zhuanlan.zhihu.com/p/2031012311192822315)

**B. 低代码 IoT 编排平台**
- **Node-RED**：流程式编程（flow-based programming）/集成工具，擅长边缘逻辑与协议转换；**不是完整 IoT 平台**——缺内建用户管理、多租户、访问控制 — [Promeraki](https://promeraki.com/blog/open-source-iot-platforms)；[ChirpStack 论坛](https://forum.chirpstack.io/t/thingspeak-node-red-ubidots-thingsboard-or-other-iot-platform/18006)。OpenJS 基金会项目，Apache-2.0
- **ThingsBoard**：完整 IoT 应用平台（设备管理 + 仪表盘 + 规则引擎 + 多租户一体）；ThingsBoard Edge 支持边缘本地处理与设备管理 — [wz-it 对比](https://wz-it.com/en/knowledge/iot/open-source-iot-platforms-compared)；[ZedIoT 边缘平台对比](https://zediot.com/blog/top-10-edge-iot-platforms-comparison-and-in-depth-analysis)
- **两者组合模式**："Node-RED 边缘数据流 + ThingsBoard 中央平台"声称可将项目周期从数月压缩到数周 — [IoT-Solution 案例文](https://www.iot-solution.com/article/armxy-node-red-thingsboard-i00436i1.html)（供应商内容，观点）
- **Losant**：低代码企业 IoT 应用使能平台（application enablement），含规则引擎 — [Losant 官网](https://www.losant.com/iot-platform)
- **Waylay**：低代码数据自动化与编排平台（Waylay IO，2021 发布），以服务包形式交付、宣称约 30 天部署 — [BusinessWire](https://www.businesswire.com/news/home/20210413005106/en/Waylay-Announces-Waylay-IO-The-First-Low-code-Developer-friendly-Data-Automation-and-Orchestration-Platform)；[Waylay 服务包页](https://www.waylay.io/service-packages)

**C. 工业连接中间件**
- **Kepware（PTC，KEPServerEX）**：定位工业连接/协议网关——基础服务器 + 按协议驱动收费（Modbus、OPC、罗克韦尔等 150+ 驱动），可加 IoT Gateway 等插件把数据北向推送；只做"连"，不做组态画面/业务编排 — [MachineCDN 对比](https://www.machinecdn.com/blog/machinecdn-vs-kepware)；[Logic 经销商页](https://www.logic-control.com/By-Brand/kepware/kepware-opc-servers/kepware-opc-servers-subscription-licenses)
- **Matrikon（霍尼韦尔）**：两条线——面向 OEM 的 Matrikon FLEX OPC UA SDK（超可伸缩、从嵌入式到大型 PC）+ MatrikonOPC 商店（500+ OPC 服务器、Tunneller 等）；SDK 按开发者授权、flat-rate — [Matrikon FAQ](https://matrikon.com/downloads/faqs)；[MatrikonOPC 商店](https://www.matrikonopc.com/store/shopping-cart.aspx)

### Inferences
- tag/点位是全行业通用接入抽象（OPC UA、PowerTag、Kepware tag、组态王点位本质同构），真正的差异化在**授权计量方式**（按点/按服务器/无限）与**编排范式**（脚本 vs 数据流 vs 规则链 vs 梯形图），而非数据模型本身
- 三层编排栈已事实分层：PLC 层梯形图/IEC 61131-3 → SCADA 层脚本+报警管线 → IoT/云层数据流+规则链；新方案的机会多在最上两层
- 连接中间件（Kepware/Matrikon）不做编排、常作为 SCADA 与 IoT 平台的下层组件共存，说明"连接"已趋于商品化，价值向上移

### Gaps
- WinCC Unified 的具体脚本/编排机制（Unified 用何种脚本语言、有无状态机工具）未从一手来源确认（置信度：低，未写入）
- AVEVA（Edge/System Platform）、Citect 的定价与能力未深入覆盖（本次检索未取得可靠公开价格）
- Waylay 现行产品与价格细节（官网未公开具体数字）

## Q2 许可证模式与大致价格

### Takeaway
四类模式并存：**按 tag/按点计费**（WinCC Unified、iFIX、传统组态王/力控）、**单服务器无限授权+模块**（Ignition，永久买断 + 年维护费）、**订阅制**（Kepware 已大体转订阅并计划 2026 涨价约 20%；ThingsBoard PE、Losant、Ignition Cloud 按用量）、**开源免费**（Node-RED Apache-2.0、FUXA MIT、OpenPLC/Scada-LTS GPL、ThingsBoard CE 开源 + PE 闭源订阅双轨）。

### Cited Findings

**Ignition**（官方定价页可直接估算，无需留邮箱）
- 三种形态：Standard（永久、按服务器）、Edge（边缘嵌入、永久）、Cloud Edition（AWS/Azure 托管、按用量 pay-as-you-go）；Maker Edition 免费（非商用）— [官方定价页](https://inductiveautomation.com/pricing/edition)
- Standard/Edge 为一次性永久授权，一服务器一 license；Standard 无限 tag/用户/设备/数据库连接；Edge 限 2 个并发客户端视图、无数据库连接、单项目、内建 35 天数据存储 — [官方定价页](https://inductiveautomation.com/pricing/edition)
- 年支持费按零售价百分比：BasicCare 16%、TotalCare 20%、PriorityCare 24%；无支持合同时大版本升级 = 当前零售价 65%；Edge 批量采购有折扣 — [官方定价页](https://inductiveautomation.com/pricing/edition)
- 具体金额（第三方口径）：起步约 $3,280 — [OperaMetrix](https://www.operametrix.com/en/compare/ignition-vs-ge-ifix)；官网价格表上"SCADA+Historian+报告"捆绑示例系统约 $13,500 — [官方价格表（经检索摘要）](https://inductiveautomation.com/pricing/list)（未逐项核验，置信度：中）
- Reddit 上有高校/小项目用户专门讨论如何选配模块省钱 — [r/PLC](https://www.reddit.com/r/PLC/comments/1osieqg/help_choosing_ignition_scada_licenses_for_college)

**WinCC Unified（西门子）**
- 运行时按 PowerTags 档位（如 10k、100k … 最高 600k）；归档 Logging Tags 单独按 100~30000 档购买；Unified Basic 面板含 50 个 logging tags、Comfort 面板含 5000（不可扩展）— [Siemens 支持文档](https://www.industry-mobile-support.siemens-info.com/en/article/detail/109995683)；[SiePortal](https://sieportal.siemens.com/en-pk/products-services/10367281)；[IndustrialMonitorDirect](https://industrialmonitordirect.com/blogs/knowledgebase/wincc-unified-powertags-reducing-tag-count-workarounds)
- 具体金额（经销商/社区口径，西门子不公开全球统一价）：TIA V21 价目中 WinCC Unified Comfort ES 约 $166；有用户称其 Unified license 约 €800 — [EandM TIA V21 价目](https://www.eandm.com/Products/Content/Siemens/TIAv21.aspx)；[社区引述]（检索摘要，置信度：低-中）

**GE iFIX / Proficy**
- iFIX 节点 license 约 $3,000–15,000+（按 tag 档）；另有"基础 $5,000–15,000/服务器 + tag 块 $2,000–8,000（500–5000 tag/块）"口径；CIMPLICITY $6,000–50,000+/服务器；存在"iFIX Plus SCADA Unlimited"不限 tag 授权 — [OperaMetrix](https://www.operametrix.com/en/compare/ignition-vs-ge-ifix)；[MachineCDN](https://www.machinecdn.com/blog/machinecdn-vs-ge-ifix)；[GaugeHow](https://gaugehow.com/tools/ge-proficy)。官方不公开报价（置信度：中，均为第三方估价）

**Kepware（PTC）**
- 官方不公布价格，走报价/经销商：第三方口径基础服务器约 $1,500–3,000，协议驱动 $500–3,000/个（通常需多个），IoT Gateway 等高级功能另收 — [MachineCDN](https://www.machinecdn.com/blog/machinecdn-vs-kepware)
- 订阅制具体数字：OPC Connectivity Suite 订阅 $676/年 — [经销商 KEPinfilink](https://kepinfilink.com/product/kepware-server-opc-connectivity-suite)；订阅首年比永久可省最多 60% — [Kepware 捷克经销商](https://kepware-opc.cz/en/licensed)
- PTC 已将 Kepware 大体转向订阅制，且据报道 2026 年计划涨价约 20%（Walker Reynolds/LinkedIn 转述，观点）— [检索摘要引 LinkedIn]；2026 授权指南见 [Allied Solutions](https://www.alliedsolutionsglobal.com/en/news/kepware-pricing-2026-kepserverex-licensing-guide)
- Reddit 用户对比 Kepware 与 Ignition（$400 永久 OPC server license 口径）后认为 Kepware 定价不透明、偏贵 — [r/PLC](https://www.reddit.com/r/PLC/comments/cralr9/anyone_with_experience_for_kepserverex_pricing)

**Matrikon（霍尼韦尔）**
- Matrikon FLEX SDK 按开发者授权、flat-rate（相对按单元/版税模式），价格需询价；OPC Tunneller→UA Tunneller 升级 $1,150；FLEX OPC UA Editor（CODESYS 插件）免费 — [Matrikon FAQ](https://matrikon.com/downloads/faqs)；[商店](https://www.matrikonopc.com/store/shopping-cart.aspx)

**低代码 IoT 平台**
- ThingsBoard：CE 开源免费；自托管 PE 免费档支持 100 设备（月度授权）、付费档自 $99/月起、Business 约 $499/月（约 1000 设备）；PE 自托管按时间订阅、**不按消息/设备额外计费**；ThingsBoard Cloud（PaaS）：Prototype $49/月、Pilot $149/月、更高档 $399/月（至 5000 设备）、约 2000 设备时约 $749 + $0.30/额外设备 — [官方定价](https://thingsboard.io/pricing)；[License Server 文档](https://thingsboard.io/docs/license-server/subscription)（不同时期价格有变动，以官网为准）
- Losant：自助档 $250/月（10 万 payloads/月，超出 $100/10 万，90 天保留）、$1,000/月（50 万 payloads/月，超出 $50/10 万）；企业版询价 — [Losant 自助定价](https://www.losant.com/self-service-plans-pricing)；[Losant 定价页](https://www.losant.com/pricing)
- Waylay：无公开标价，以服务包形式销售 — [Waylay](https://www.waylay.io/service-packages)

**开源协议**（GitHub API，2026-10-01/02）
- Node-RED：Apache-2.0；ThingsBoard CE：开源（GitHub 标注 NOASSERTION，商用需自行核对条款，置信度：中）；FUXA：MIT（另有 ~€100 的付费 pro 版 — [OpenPLC 论坛](https://openplc.discussion.community/post/scada-visualisations-13624858)）；Scada-LTS：GPL-2.0；OpenPLC：GPL-3.0

### Inferences
- 按 tag 计费在大点位项目成本失控，是 Ignition"无限授权"崛起的根源；中国厂商的"免费化"浪潮正在复制同一冲击（见 Q5）
- 订阅化是大势（PTC/Kepware、GE、ThingsBoard、Losant、Ignition Cloud），但与集成商"一次性交付"的商业模式冲突，是当前社区负面情绪的主要来源之一
- "价格不透明/必须询价"（GE、Kepware、Matrikon、Waylay 共有）本身即是中小客户的痛点与竞品机会

### Gaps
- Ignition 各模块（Perspective、Reporting、Tag Historian 等）逐项美元单价未取得一手数字（官方页面为交互估算器，未能抓取完整表）
- 组态王/力控的点数授权单价无公开数字（国内以项目报价为主，未见公开价目）
- 西门子 WinCC Unified 全球统一美元/欧元价目无法公开核实（区域定价差异大）

## Q3 用户（尤其中小集成商与设备厂商）的抱怨与未满足需求

### Takeaway
社区高频抱怨集中在：贵且按点收费、UI/工具链老旧（"停留在 2000 年代初"）、学习曲线陡、冗余等关键功能有 bug（AVEVA 被点名）、版本控制与工程化管理缺失、厂商锁定与价格不透明、订阅化+涨价（Kepware）。最强烈的信号是多名从业者"自己动手造平台"并考虑开源——说明"中小点位数 + 现代 Web + 低成本 + 可工程化"这一区间存在明显供给空白。（此节多为社区轶事证据，置信度：中）

### Cited Findings
- "AVEVA SCADA IS A CURSE"（r/SCADA，2024）：用户报告 bug 多、冗余功能故障、学习和编程体验痛苦 — [Reddit](https://www.reddit.com/r/SCADA/comments/1ggqab6/aveva_scada_is_a_curse)（观点/轶事）
- "Built my own industrial control platform after…"（r/PLC）：自述动机是"SCADA 软件太贵、太复杂"，客户系统问题反复出现 — [Reddit](https://www.reddit.com/r/PLC/comments/1rst50v/built_my_own_industrial_control_platform_after)（观点）
- "What's wrong with SCADA-systems interfaces?"（r/PLC）：批评界面"卡在 2000 年代初"，原因是没人有时间做正经 UI 开发 — [Reddit](https://www.reddit.com/r/PLC/comments/168b6yx/whats_wrong_with_scadasystems_interfaces)（观点）
- "System integrator bad practices"（r/PLC）：项目人员频繁切换、版本控制糟糕、缺 IT 知识 — [Reddit](https://www.reddit.com/r/PLC/comments/v0yr5c/system_integrator_bad_practices)（观点）
- "My company is considering open sourcing its SCADA"（r/PLC）：厂商因对现有方案不满自建 SCADA 后考虑开源 — [Reddit](https://www.reddit.com/r/PLC/comments/1gmswqf/my_company_is_considering_open_sourcing_its_scada)
- 集成商与工厂的摩擦：代码为批量复制而非现场定制设计 — [Reddit](https://www.reddit.com/r/PLC/comments/1caz4av/what_is_a_big_problem_that_makes_either)（观点）
- Kepware 转订阅 + 2026 年拟涨价约 20% 在社区引发不满（转述）— [检索摘要引 Walker Reynolds/LinkedIn]（观点）；价格不透明需询价 — [r/PLC](https://www.reddit.com/r/PLC/comments/cralr9/anyone_with_experience_for_kepserverex_pricing)
- WinCC 用户需要研究"如何减少 PowerTag 数量以塞进授权档位"的 workaround — [IndustrialMonitorDirect](https://industrialmonitordirect.com/blogs/knowledgebase/wincc-unified-powertags-reducing-tag-count-workarounds)（事实：存在此类需求；反映按点计费痛感）
- 国内批评：传统组态软件"按点收费"+"封闭系统" — [云质变评测](https://www.yunzhibian.com/software-intelligence-platform-content134.html)（观点）；"国产 SCADA 免费化浪潮不可逆转" — [知乎](https://zhuanlan.zhihu.com/p/27819111988)（观点/分析）
- r/SCADA 日常话题：Windows 缩放/混合 DPI 问题、老工程工具难用 — [r/SCADA](https://www.reddit.com/r/SCADA)（轶事）

### Inferences
- 痛点可归纳为四类：**成本结构**（按点/订阅/涨价）、**工程化缺失**（版本控制、可复制性、CI/CD）、**技术陈旧**（UI、Web 能力、混合 DPI 等桌面时代问题）、**锁定与不透明**（专有格式、询价制）
- "自建平台"帖子反复出现，是中小集成商/设备厂商需求外溢（build vs buy 天平倾斜）的直接证据；目标客群对"能嵌入自己产品、按项目复制"的 OEM 友好型方案有明确需求
- 设备厂商（OEM）场景与集成商不同：更在意可嵌入、单机成本低、可品牌化（Ignition Edge 即为此设计），这一细分竞争相对少

### Gaps
- 缺乏量化的用户满意度/流失率调查数据；本节结论基于社区轶事聚合，置信度中等
- 中文社区（知乎/贴吧）上对 WinCC/iFIX 的具体抱怨样本本次未系统采集（知乎文章被 403 拦截，仅获检索摘要）

## Q4 开源方案（Node-RED、ThingsBoard、FUXA、OpenPLC、Scada-LTS 等）的成熟度、社区活跃度与商用可行性

### Takeaway
Node-RED（23.7k star）与 ThingsBoard（22.5k star）是仅有的两个社区规模达两万星级的头部项目，活跃且商用可行（ThingsBoard 另有闭源 PE 订阅双轨）；FUXA（5.1k star，MIT）在 Web 可视化层成熟、常与 OpenPLC 搭配，但企业级 SCADA 功能（用户体系、高可用）欠缺；Scada-LTS（1k star，GPL-2.0）活跃度低、积压 issue 多；OpenPLC（v3 1.6k star；v4 已迁至 Autonomy Logic 商业实体）填补开源软 PLC 空白但生态小。开源在"采集+可视化"层已可用，在冗余/认证/长期支持等企业特性上与商用仍有差距。

### Cited Findings（GitHub API 快照，2026-10-01/02，[api.github.com](https://api.github.com)）
- **Node-RED**：node-red/node-red，23,701 stars / 3,895 forks / 357 open issues，最后 push 2026-10-01，Apache-2.0——成熟、极活跃
- **ThingsBoard**：thingsboard/thingsboard，22,502 stars / 6,489 forks / 321 open issues，最后 push 2026-10-01，license 标注 NOASSERTION（CE 开源 + PE 商业订阅双许可模式）
- **FUXA**：frangoteam/fuxa，5,072 stars / 1,374 forks / 397 open issues，最后 push 2026-10-01，MIT——Web SCADA/HMI，持续有新驱动发布（如三菱 PLC 直读）— [GitHub](https://github.com/frangoteam/fuxa)；社区反馈"容易上手但缺进阶教程"、pro 版约 €100 — [OpenPLC 论坛](https://openplc.discussion.community/post/scada-visualisations-13624858)
- **Scada-LTS**：SCADA-LTS/Scada-LTS，1,015 stars / 341 forks / 219 open issues（相对规模偏高），最后 push 2026-07-24，GPL-2.0——维护节奏明显慢于头部项目
- **OpenPLC**：thiagoralves/OpenPLC_v3，1,572 stars，最后 push 2026-04；v4（runtime 381 stars / editor 402 stars，最后 push 2026-10-02，即本周）已迁至 **Autonomy Logic** 公司名下（OpenPLC Runtime v4）— [GitHub 搜索](https://github.com/search?q=OpenPLC)（v4 转向商业实体运营，开源边界待观察）
- **Beremiz**（IEC 61131-3 开源 IDE）：438 stars，最后 push 2026-09-22 — [GitHub](https://github.com/beremiz/beremiz)
- Node-RED 定位边界：缺内建用户管理/多租户/访问控制，不是完整 IoT 平台 — [Promeraki](https://promeraki.com/blog/open-source-iot-platforms)
- OpenPLC 官方文档推荐 FUXA/ScadaBR 作为其可视化配套 — [OpenPLC 用户指南 PDF](https://doc-en.rvspace.org/VisionFive2/PDF/VisionFive2_OpenPLC.pdf)
- 典型组合："Node-RED（边缘）+ ThingsBoard（中心）"压缩交付周期 — [IoT-Solution](https://www.iot-solution.com/article/armxy-node-red-thingsboard-i00436i1.html)（供应商内容）

### Inferences
- 商用可行性分层：Node-RED（Apache-2.0，OpenJS 治理，可放心商用）> ThingsBoard CE（可商用但许可条款需核对）> FUXA（MIT 可商用，但社区单点依赖 frangoteam 团队）> Scada-LTS（GPL-2.0 + 低活跃度，商用风险高）> OpenPLC（v4 商业实体化，开源承诺不确定）
- 开源方案共同短板：高可用/冗余、功能安全/安全认证、责任主体与 SLA、驱动广度（尤其非 Modbus/OPC 的私有协议）——这恰是 Kepware（150+ 驱动）等中间件的护城河
- ThingsBoard 的"CE 引流 + PE 变现"是开源工业软件最成功的商业化路径样本，值得对标

### Gaps
- ThingsBoard CE 许可证具体条款（GitHub NOASSERTION 的原因，是否为 Apache-2.0 附加条件）未逐条核实——商用前需法律审查（置信度：中）
- FUXA/Scada-LTS 的实际生产部署规模无可靠统计
- GH issue 数为总量快照，未做时间序列对比（无法量化"活跃度趋势"，仅有单点数据）

## Q5 中国市场特殊因素：国产化/信创、组态王/力控等本土生态的位置

### Takeaway
信创/国产化是中国市场最大结构变量：力控等厂商以"全栈国产适配（麒麟/统信 UOS + 飞腾/龙芯/鲲鹏）"为核心竞争筹码；组态王是存量龙头但被普遍认为架构老化，正以 KingFactory 平台化转型；"免费化 + Web 化"浪潮正在冲击本土传统"按点收费"模式；国际厂商（西门子/PTC/GE）在信创敏感采购中处于结构性劣势，为本土与新进入方案留出空间。

### Cited Findings
- **组态王（亚控科技）**：约 30 年历史，KingView→KingSCADA→KingFactory 演进；官方宣称"SCADA 领域中国已与美、德、法并列全球四强"（厂商宣称）— [亚控官网](https://www.kingview.com/news_info.php?num=1002846)
- **产品定位（2026 横评）**：KingSCADA 定位大型复杂工业监控（分布式、百万 IO、冗余）；力控产品线更全、兼顾传统组态与 Web 路线 — [知乎 2026 国产 SCADA 横评](https://zhuanlan.zhihu.com/p/2031012311192822315)
- **生态类型**：组态王、力控、昆仑通态 MCGS 属"设备绑定型"组态，核心逻辑"跟硬件走" — [CSDN](https://bbs.csdn.net/weixin_30175731/article/details/100392544)
- **信创适配**：国产产品宣称从内核、通信驱动到图形引擎全自研，已适配麒麟、统信 UOS 及飞腾、龙芯、鲲鹏国产芯片 — [CSDN 选型文](https://blog.csdn.net/qq_41278930/article/details/161866551)（多为厂商口径，置信度：中）
- **免费化冲击**：分析认为"国产 SCADA 免费化浪潮不可逆转"——组态王需加速架构转型，力控可借信创优势扩大份额，策略上以免费软件为入口构建"硬件+服务"生态 — [知乎分析](https://zhuanlan.zhihu.com/p/27819111988)（观点/分析）
- **行业批评**：传统组态软件被批"按点收费"与"封闭系统" — [云质变](https://www.yunzhibian.com/software-intelligence-platform-content134.html)（观点）
- **技术路线分类**：组态王、力控与 WinCC 并列为"传统组态软件路线"代表，与数采平台、Web 组态、IoT 平台等路线并存 — [掘金](https://juejin.cn/post/7686803938520481802)

### Inferences
- 中国市场对新方案存在两个方向相反的压力：**信创合规是入场券**（不适配国产 OS/CPU 就进不了部分项目）与**免费化价格战**（监控组态本身越来越难单独收费）——因此差异化必须建立在编排/工程化能力而非组态画面本身
- 国产厂商"设备绑定型"基因（跟硬件走）意味着它们在纯软件编排层（跨品牌设备协同、现代 DevOps 式工程管理）相对薄弱，可能存在空白
- 组态王/力控的 Web 化、平台化转型（KingFactory、力控 Web 路线）与 Ignition/IoT 平台的路线趋同，未来竞争焦点在平台层而非 HMI 层

### Gaps
- 信创政策对 SCADA 采购的强制性程度（是否存在官方目录/清单强制要求）未找到权威政府文件，仅有厂商与媒体口径（置信度：中）
- 组态王/力控的市场份额、营收、装机量无公开可靠数据（官方"四强"说亦无法独立验证）
- 知乎原文正文因 403 未能完整读取，Q5 部分结论基于搜索结果摘要（置信度：中）

---

## 来源清单（去重）

**官方一手来源**
- [Inductive Automation 定价页](https://inductiveautomation.com/pricing/edition) / [价格表](https://inductiveautomation.com/pricing/list)
- [Siemens PowerTags 说明](https://www.industry-mobile-support.siemens-info.com/en/article/detail/109995683) / [SiePortal Logging Tags](https://sieportal.siemens.com/en-pk/products-services/10367281)
- [EandM TIA Portal V21 价目](https://www.eandm.com/Products/Content/Siemens/TIAv21.aspx)
- [ThingsBoard 定价](https://thingsboard.io/pricing) / [License Server 文档](https://thingsboard.io/docs/license-server/subscription)
- [Losant 自助定价](https://www.losant.com/self-service-plans-pricing) / [Losant 定价](https://www.losant.com/pricing)
- [亚控科技官网新闻](https://www.kingview.com/news_info.php?num=1002846)
- [Matrikon FAQ](https://matrikon.com/downloads/faqs) / [MatrikonOPC 商店](https://www.matrikonopc.com/store/shopping-cart.aspx)
- [GitHub API](https://api.github.com)（2026-10-01/02 快照：node-red、thingsboard、fuxa、OpenPLC_v3、Scada-LTS、beremiz）

**第三方分析/经销商**
- [OperaMetrix: Ignition vs iFIX](https://www.operametrix.com/en/compare/ignition-vs-ge-ifix) / [Ignition vs 传统 SCADA](https://www.operametrix.com/en/blog/ignition-vs-traditional-scada-comparison)
- [MachineCDN: vs Kepware](https://www.machinecdn.com/blog/machinecdn-vs-kepware) / [vs iFIX](https://www.machinecdn.com/blog/machinecdn-vs-ge-ifix)
- [GaugeHow: GE Proficy 定价](https://gaugehow.com/tools/ge-proficy)
- [Allied Solutions: Kepware 2026 授权指南](https://www.alliedsolutionsglobal.com/en/news/kepware-pricing-2026-kepserverex-licensing-guide)
- [IndustrialMonitorDirect: PowerTag 档位指南](https://industrialmonitordirect.com/blogs/knowledgebase/wincc-unified-powertags-reducing-tag-count-workarounds)
- [ARC Advisory SCADA 研究目录](https://www.arcweb.com/market-studies/scada-systems-market-data-studies)；市场规模的 [Fortune BI](https://www.fortunebusinessinsights.com/scada-market-102433)、[M&M](https://www.prnewswire.com/news-releases/scada-market-worth-24-69-billion-by-2032---exclusive-report-by-marketsandmarkets-302867459.html)、[Mordor](https://www.mordorintelligence.com/industry-reports/supervisory-control-and-data-acquisition-market)

**社区/中文来源**
- Reddit r/PLC 与 r/SCADA 各帖（见 Q3 内联链接）
- [知乎：国产 SCADA 免费化与组态王/力控分析](https://zhuanlan.zhihu.com/p/27819111988) / [知乎：2026 国产 SCADA 横评](https://zhuanlan.zhihu.com/p/2031012311192822315)
- [CSDN：组态软件三大路线](https://bbs.csdn.net/weixin_30175731/article/details/100392544) / [CSDN：信创适配选型](https://blog.csdn.net/qq_41278930/article/details/161866551)
- [云质变：3 款主流 HMI/SCADA 横评](https://www.yunzhibian.com/software-intelligence-platform-content134.html) / [掘金：数据采集平台四条路线](https://juejin.cn/post/7686803938520481802)
- [Promeraki 开源 IoT 平台对比](https://promeraki.com/blog/open-source-iot-platforms) / [wz-it 对比](https://wz-it.com/en/knowledge/iot/open-source-iot-platforms-compared) / [OpenPLC 论坛](https://openplc.discussion.community/post/scada-visualisations-13624858)
