# 工业设备控制/编排软件系统架构与工程实践（截至 2026 年）

> 说明：本笔记为多源调研汇总。所有条目尽量区分【事实】（有来源支撑）与【观点/推断】；供应商自述的对比数据已标注"供应商自述、未经第三方验证"。置信度标注：高 = 官方文档或多方一致；中 = 单一可信来源或行业惯例；低 = 社区讨论/供应商营销。

## 部署形态取舍：边缘网关 vs 工控机 on-prem vs 云端；南向/北向分层

### Takeaway
2026 年的主流共识是"分层混合部署"：南向（设备接入）放在靠近 PLC 的边缘/on-prem 节点，北向（MES/云/报表）通过 MQTT 等消息中间件汇聚到云端或企业层。成熟产品（Ignition、ThingsBoard）都是同一代码库覆盖从 Raspberry Pi 级边缘到云端的全谱系，而不是为不同层级做不同产品。

### Cited Findings
- 【事实·高】Ignition 官方列出六种标准架构：Basic（单台 on-prem 服务器连 SQL 库、PLC、客户端）、Scale-Out（多 Gateway 去中心化分担负载）、Hub & Spoke（中心 Gateway 连接多本地/远程站点）、Enterprise（本地/远程站点数据上行至公司总部与云服务）、IIoT（基于 MQTT 消息中间件 MOM，可部署在云端、on-prem 私网或混合）、Cloud Hybrid（云端弹性扩展 + 数据存储 + 分析）— [Ignition 官方架构页](https://inductiveautomation.com/ignition/architectures)
- 【事实·高】Ignition 是"服务器为中心、Web 化部署"模型：一个中央 Gateway 通过浏览器/客户端启动方式向任意数量的设备分发"零安装"客户端；官方宣称 3 分钟完成服务器安装，更新由服务器推送至所有客户端且无停机 — [Ignition 官方架构页](https://inductiveautomation.com/ignition/architectures)
- 【事实·高】Ignition Edge 版可运行"到网络最边缘"，包括 Raspberry Pi 级小设备，与大云端服务器使用同一代码库 — [Ignition 官方架构页](https://inductiveautomation.com/ignition/architectures)；[Ignition 8.1 官方文档系统架构目录](https://www.docs.inductiveautomation.com/docs/8.1/system-architectures)（含 Edge、Enterprise、Redundancy、Cloud Based、AWS Outposts 等子架构）
- 【事实·高】多 Gateway 之间通过安全 Gateway Network 提供"分布式服务"：跨 Gateway 的 tag 浏览、实时读写、报警集中发送/接收/确认（acknowledge）、跨 Gateway 历史查询；支持 Controller Gateway 管理多个 Agent Gateway — [Ignition 官方架构页](https://inductiveautomation.com/ignition/architectures)
- 【事实·高】ThingsBoard 采用三层组件：Core（平台）、Edge（边缘，本地自治 + 云同步）、IoT Gateway（Python 实现的开源网关，把 Modbus/OPC UA/BLE 等传统设备经 MQTT 桥接进平台，无需改固件）— [ThingsBoard IoT Gateway 官方文档](https://thingsboard.io/docs/iot-gateway)；[ThingsBoard Gateway GitHub](https://github.com/thingsboard/thingsboard-gateway)；[Medium 深度解析](https://medium.com/engineering-iot/navigating-the-iot-landscape-a-deep-dive-into-thingsboard-core-edge-and-gateway-cf9846d602e3)
- 【事实·高】ThingsBoard PE 微服务版将"集成执行器"（Integration Executor）独立为微服务，运行 OPC-UA、SigFox、TTN 等外部系统拉取/推送集成 — [ThingsBoard PE 微服务架构文档](https://thingsboard.io/docs/pe/reference/architecture/microservices)
- 【事实·高】工业协议网关参考架构明确按"南向（Modbus/OPC UA/BACnet/S7 等设备协议）→ 边缘转换/缓冲 → 北向（MQTT/REST 到云或 IT 系统）"分层，并叠加 IEC 62443 分区思想 — [IoT Digital Twin PLM 参考架构指南（2026）](https://iotdigitaltwinplm.com/industrial-protocol-gateway-solutions-guide)
- 【事实·中】IIoT 边缘网关的标配能力：协议转换、store-and-forward 缓冲、边缘过滤/规则引擎/本地报警、OT/IT 安全边界 — [Harmony AI：IIoT Gateways](https://www.tryharmony.ai/iiot-gateways)；[ANEXEE 2026 边缘平台选型](https://www.anexee.com/blog/industrial-edge-computing-gateway-platforms-2026)
- 【事实·中】OPC 基金会官方开源了 UA-EdgeTranslator，用 W3C Web of Things 物模型把专有协议翻译为 OPC UA——说明"边缘协议翻译器"已是基金会级标准化方向 — [OPC Foundation UA-EdgeTranslator GitHub](https://github.com/opcfoundation/ua-edgetranslator)
- 【事实·中】有厂商产品在边缘网关上同时暴露 OPC UA Server（南向 tag 供 SCADA 读取）+ 蜂窝网上行 + store-and-forward 断线缓存（典型场景：远程泵站）— [SGT Systems IIoT Edge Gateway](https://sgtsystems.com/products/iiot-edge-gateway)

### Inferences
- 【推断】对从零自研的软件，部署形态不应是"三选一"，而应做成同一核心运行时 + 不同打包（边缘小盒/工控机/服务器/容器）。Ignition（同一代码库跑 Pi 到云）和 ThingsBoard（Core/Edge/Gateway 三件套）都验证了这条路线。
- 【推断】北向解耦用 MQTT 消息中间件（面向消息、天然支持断线重连与缓冲）比让云端直连 OPC UA 更符合 IEC 62443 分区（南向 OT 区不直接暴露给 IT 区）。Ignition IIoT 架构与多数边缘网关参考架构均以此为默认。
- 【观点·中】社区实操反馈：ThingsBoard 约 2 万设备规模时才需要考虑切微服务部署，单体版在中小规模够用——说明自研系统 MVP 用单体 + 模块化比一开始上 K8s 微服务更务实 — 参考 [Reddit r/selfhosted 讨论](https://www.reddit.com/r/selfhosted/comments/1uezzao/switching_to_microservices_in_thingsboard)

### Gaps
- 未找到权威的"工控机 on-prem 与边缘网关在 TCO/维护成本上的定量对比"；现有来源多为厂商营销内容，无法给出可引用数字。
- 国内工控现场（如国产 PLC、电力规约 DL/T 645、101/104 等）特有南向协议生态没有权威英文来源覆盖；需要另行调研（标注：本研究以国际主流协议为主）。

## 数据层：实时 tag 库、时序数据库选型、断线缓存与补传、报警/事件存储

### Takeaway
主流做法是"实时 tag 库（内存 + 内存映射/共享内存，供订阅推送）与时序历史库分离"，历史库在 InfluxDB 3、TDengine 3.x、TimescaleDB、VictoriaMetrics 中选；断线缓存（store-and-forward）是数据层标配而非可选项。四个候选中：VictoriaMetrics 在摄入性能与资源占用上多项第三方基准领先；TimescaleDB 胜在标准 SQL/Postgres 生态；InfluxDB 3 OSS 能力受限（集群在企业版）；TDengine 对 IoT 场景有原生超级表设计但为 AGPLv3 许可（商用集成有传染风险）。

### Cited Findings
- 【事实·中，供应商自述】TDengine 官方对比表（仅覆盖 InfluxDB/TimescaleDB）：数据模型上 TDengine 为"时序原生关系模型（超级表+子表）"、InfluxDB 为 measurement+tags（"灵活但易遇基数问题"）、TimescaleDB 为 Postgres 扩展（继承关系型 schema）；查询语言 TDengine 与 TimescaleDB 用标准 SQL，InfluxDB 用私有 InfluxQL；许可证 TDengine=AGPLv3、InfluxDB=MIT/Apache 2.0、TimescaleDB=Apache 2.0 + 部分功能 Timescale License；边缘-云同步能力 TDengine 自评"原生最好"、InfluxDB "中等（靠 Telegraf 变通）"、TimescaleDB "低（需外部复制）" — [TDengine 官方选型指南（2025）](https://tdengine.com/how-to-choose-the-best-time-series-database)。注意：该页为 TDengine 营销内容，几乎所有维度自评"Best"，性能数字无第三方方法论。
- 【事实·中】VictoriaMetrics 基准（部分来自其作者 Valyala）：inch 基准下 1–2M 基数时 VictoriaMetrics 摄入性能为 InfluxDB 的 4–5 倍，InfluxDB 在 3–4M 基数时性能急剧退化 — [Valyala (VictoriaMetrics 作者) Medium](https://valyala.medium.com/insert-benchmarks-with-inch-influxdb-vs-victoriametrics-e31a41ae2893)；对 InfluxDB IOx 的对比中单节点 VictoriaMetrics 摄入性能近 6 倍 — [VictoriaMetrics 官方博客](https://victoriametrics.medium.com/first-look-at-perfomance-comparassion-between-influxdb-iox-and-victoriametrics-e590f847935b)
- 【事实·中】第三方汇总（2026）：VictoriaMetrics 相比 InfluxDB 有 7–10 倍更低内存、2–3 倍更低磁盘占用（自定义时序存储格式）；Reddit/PeerSpot 等第三方反馈总体确认"摄入更快、内存更省、高基数更好"的趋势，但多数基准源于 VM 团队 — [NovaAI 2026 对比](https://novaaiops.com/blog/prometheus-vs-influxdb-vs-victoriametrics-2026)；[devops.dev 低负载对比（树莓派 Zero W：单操作 InfluxDB ~136ms vs VM ~52ms）](https://blog.devops.dev/ticktockdb-influxdb-and-victoricmetrics-comparison-under-low-loads-raspberry-pi-0-w-1875365205f4)；[Reddit r/Database 讨论](https://www.reddit.com/r/Database/comments/1jal3fe/choosing_a_timeseries_data_base_for_high)
- 【事实·高】InfluxDB 3 Core 于 2025 年 4 月 GA；社区普遍指出 InfluxDB 3 开源版能力受限（集群/高可用归企业版），这是 OSS 用户的常见顾虑 — [Medium: InfluxDB 3 Core 与 TimescaleDB 实测模式对比](https://medium.com/@artemkhrenov/time-series-database-patterns-influxdb-and-timescaledb-for-analytics-32daf132297f)；[Reddit r/Database 讨论](https://www.reddit.com/r/Database/comments/1jal3fe/choosing_a_timeseries_data_base_for_high)
- 【事实·高】TimescaleDB：PostgreSQL 扩展，hypertable/chunk 分片，压缩功能可用；社区版部分企业功能（如集群）在 Timescale License（非开源）下 — [TDengine 对比页](https://tdengine.com/how-to-choose-the-best-time-series-database)；[InfluxData 官方对比页（供应商视角）](https://www.influxdata.com/comparison/tdengine-vs-timescaledb)
- 【事实·高】断线缓存/store-and-forward 是 2026 年边缘网关/边缘平台的必备能力项：可配置缓冲、断网续传、本地规则引擎与报警在断网期间继续工作 — [ANEXEE 2026 边缘平台选型](https://www.anexee.com/blog/industrial-edge-computing-gateway-platforms-2026)；[Harmony AI](https://www.tryharmony.ai/iiot-gateways)；[OPC UA 边缘网关定义（含断线期间本地存储/缓冲）](https://automation-networks.com/glossary/opc-ua-edge-gateway)；[Wevolver: 网关边缘 vs 云部署模式](https://www.wevolver.com/article/iot-gateway-architecture-edge-vs-cloud-protocol-translation-and-deployment-patterns)
- 【事实·高】报警（alarm）作为一等公民跨节点分发：Ignition Gateway Network 提供跨 Gateway 的报警集中"发送/接收/确认"（send/receive/acknowledge）— [Ignition 官方架构页](https://inductiveautomation.com/ignition/architectures)
- 【事实·中】TSDB 选型的常见评估维度（非单一性能）：连接器生态、REST API、Grafana 集成、SQL 支持、压缩、基数处理、许可证 — [TDengine 选型指南](https://tdengine.com/how-to-choose-the-best-time-series-database)；[Tiger Data 10 款 TSDB 对比](https://www.tigerdata.com/learn/the-best-time-series-databases-compared)；[QuestDB 2026 TSDB 指南](https://questdb.com/blog/best-time-series-databases)

### Inferences
- 【推断】对"多协议接入 + 逻辑编排"软件：实时 tag 库应自研（内存态、支持订阅/回调、毫秒级），历史库直接嵌入成熟 TSDB。若团队熟 Postgres → TimescaleDB（SQL 生态、报警/事件可直接用 Postgres 表）；若追求边缘低资源占用与高摄入 → VictoriaMetrics（单二进制、极省内存，适合边缘盒子）；避免在 MVP 阶段绑定 InfluxDB 3 OSS 的受限功能。
- 【推断】TDengine 的 AGPLv3 意味着若把它以库/服务形态紧耦合进闭源商业产品并分发，存在被要求开源的风险（AGPL 对网络使用也有条款）；除非走其商业授权，否则闭源商用需谨慎（详见"许可证风险"节）。
- 【推断】报警/事件存储在开源资料中多作为实时流处理特性（产生/分发/确认）被讨论，而非独立存储选型问题——业界惯例是把报警记录写入通用关系库或时序库的独立表/测量，未见专门的"报警数据库"品类。

### Gaps
- 未找到对"实时 tag 库内部实现"（共享内存、内存映射文件、组播订阅等）的权威公开文档；成熟商业 SCADA（如 WinCC、iFIX、Ignition tag provider）的内部实时库机制不公开。相关细节需依赖 Ignition tag provider 概念文档或源码开放的 OpenSCADA（本次未深入）。
- TDengine 官方对比页完全未覆盖 VictoriaMetrics 与 QuestDB；VictoriaMetrics 侧也缺少官方对 TDengine 的对比——四库同台的独立第三方基准（尤其是 2026 年、含边缘场景）缺失，现有交叉对比需拼接多个来源且各有偏向。
- 报警/事件存储的容量规划与保留策略（如报警洪泛抑制、SOE 顺序事件记录精度）没有找到可引用的公开最佳实践文档。

## 可靠性：7x24 无人值守、进程看门狗、崩溃恢复、双机冗余/故障切换

### Takeaway
工控行业标准做法是"热备双机（hot standby）+ 专用心跳链路 + tag 库/状态同步 + 自动切换"，并将冗余分层扩展到网络、RTU/PLC 通道、电源与磁盘（RAID）。要清醒认识：冗余是"转移故障点"而非消灭故障——每种冗余架构引入自己的故障模式。

### Cited Findings
- 【事实·高】热备（hot standby）模式：备用服务器与主服务器完全同步，故障切换毫秒级、零数据丢失；暖备（warm standby）：备机运行但不完全同步，故障切换发起后才开始采集 — [VNode Automation: Hot vs Warm Standby](https://vnodeautomation.com/hot-standby-warm-standby-iioT-redundancy)
- 【事实·高】SCADA 高可用设计为多层：热备服务器对 + 专用心跳（heartbeat）链路 + 分层的网络与电源冗余 — [Industrial Monitor Direct: SCADA Redundancy Design](https://industrialmonitordirect.com/blogs/knowledgebase/scada-redundancy-design-failover-architecture-for-high-availabili)
- 【事实·高】端到端冗余实践：双 SCADA 服务器 + 双 RTU + 双 SIM 卡保持数据与控制不中断，热备自动切换 — [MikroDev 冗余设计](https://www.mikrodev.com/redundancy-design-seamless-operation-with-dual-scada-servers-dual-rtus-and-dual-sim)
- 【事实·高】ORPAON 工程实践汇总：冗余集群、双机热备、数据库 RAID1、面向 7x24 运行设计 — [ORPAON: SCADA Redundancy and High Availability](https://global.orpaon.com/en/column/scada-redundancy-high-availability)
- 【观点·高（工程共识）】"冗余转移故障点而非消除它——每种架构都有不同的故障模式" — [IT-ASP Dijital: SCADA Redundancy and Failover](https://it-aspdijital.com/en/blog/scada-redundancy-failover-basics)
- 【事实·高】OPC 服务器冗余分热/暖/冷三档：热冗余同时订阅主备两台服务器，切换瞬时、无数据丢失；暖备部分同步；冷备需手动/重启 — [OPC Expert: OPC Server Redundancy](https://opcexpert.com/blog/opc-server-redundancy-hot-warm-cold-failover)
- 【事实·高】Ignition 将冗余（Redundancy）作为一等架构选项（官方架构目录含 Redundancy Architecture 子页；架构图带"show redundancy"切换）— [Ignition 官方架构页](https://inductiveautomation.com/ignition/architectures)；[Ignition 8.1 文档目录](https://www.docs.inductiveautomation.com/docs/8.1/system-architectures)
- 【事实·中】热备配置可实现"自动故障切换、无缝切换、无需操作员干预" — [TECO Group 热冗余配置](https://tecogrp.com/products/scada-automation/hot-redundant-configuration)
- 【事实·中】断网期间边缘侧继续本地采集 + 缓冲 + 补传（store-and-forward），是 7x24 无人值守站点数据不丢的标配 — [ANEXEE 2026 边缘平台选型](https://www.anexee.com/blog/industrial-edge-computing-gateway-platforms-2026)；[SGT Systems](https://sgtsystems.com/products/iiot-edge-gateway)

### Inferences
- 【推断】看门狗/崩溃恢复的具体机制（systemd WatchdogSec、硬件看门狗、进程自动拉起）在本次来源中未见专门论述，但属于 Linux/OS 层标准能力；结合上述"自动切换无需人工干预"的行业要求，自研系统至少应做到：服务由 init 系统托管自动重启 + 关键状态落盘可恢复 + 心跳超时触发备机接管。此条为基于工程常识的推断，置信度中。
- 【推断】MVP 阶段的合理裁剪顺序：先做"进程级自愈（自动重启 + 崩溃后状态恢复 + 断线缓存补传）"，双机热备（心跳协议、状态同步、仲裁）放到第二阶段——因为热备的一致性协议复杂度高，而多数单站点场景单机 + 快速重启已可达 99.9% 可用性。此为推断，未见公开数据支撑具体可用性数字。

### Gaps
- 未找到公开的心跳协议实现细节（如 Ignition 冗余模块的心跳间隔/仲裁机制、双主脑裂处理），商业实现均闭源。
- 进程看门狗与崩溃恢复的系统性公开文献缺失（现有来源全部聚焦双机冗余层）；需要后续看 systemd 文档或特定产品手册补充。
- 未找到权威的可用性等级与冗余方式对应表（如何种场景需要 SL 几级/热备还是暖备）。

## 安全：RBAC、操作审计、网络分区、IEC 62443、证书与加密

### Takeaway
IEC 62443 的核心是"区域（zone）—管道（conduit）"模型：按安全需求把资产分区，区际通信经显式的管道（防火墙、工业协议网关、单向网关/数据二极管、IDS/IPS）管控，并按风险给每个区定安全等级 SL1–SL4。自研软件应至少做到：南北向协议全部支持加密与证书（OPC UA/MQTT TLS）、用户-角色-权限模型、操作审计日志、以及部署上支撑分区（边缘节点作为 OT/IT 边界）。

### Cited Findings
- 【事实·高】IEC 62443 采用纵深防御 + 分区分段 + 风险评估 + 认证工具的分层安全框架 — [Rockwell Automation: IEC 62443 指南](https://www.rockwellautomation.com/en-us/company/news/blogs/iec-62443-security-guide.html)
- 【事实·高】IEC 62443-3-2 定义：conduit 是"共享共同安全要求、连接两个或多个 zone 的通信信道的逻辑分组"；zone 是按共同安全要求分组的资产集合 — [FedCo International（LinkedIn）](https://www.linkedin.com/pulse/iec-62443-zones-conduits-security-levels-fedco-international-d4ajc)；[MDPI 学术论文](https://www.mdpi.com/2624-800X/6/2/52)
- 【事实·高】conduit 的落地机制：防火墙、工业协议网关、数据二极管（data diode）、单向网关、IDS/IPS — [VNode Automation: OT 网络分区实践](https://vnodeautomation.com/ot-network-segmentation-zones-conduits-iec-62443)；[Keyfactor: Mastering IEC 62443](https://www.keyfactor.com/education-center/mastering-iec-62443-a-guide-to-securing-industrial-automation-and-control-systems)
- 【事实·高】四个安全等级 SL1–SL4，从"偶然违规"到"国家级攻击" — [Fortinet: IEC 62443 概述](https://www.fortinet.com/resources/cyberglossary/iec-62443)；从业者指南建议按区做风险评估后分配 SL 并围绕区边界设计纵深防御 — [OT Security Wire 从业者指南](https://otsecuritywire.com/articles/iec-62443-security-levels-zone-conduit-model-practitioner-guide)
- 【事实·中】MDPI 论文指出：按 IEC 62443 进行网络安全风险分析时，建立 zones 与 conduits 是保护 ICS 的关键活动 — [MDPI](https://www.mdpi.com/2624-800X/6/2/52)
- 【事实·中】边缘网关被明确定位为 OT/IT 安全边界组件（协议翻译 + 安全点），2026 年参考架构将 IEC 62443 与南向/北向分层绑定 — [Harmony AI](https://www.tryharmony.ai/iiot-gateways)；[IoT Digital Twin PLM 参考架构（2026）](https://iotdigitaltwinplm.com/industrial-protocol-gateway-solutions-guide)
- 【事实·高】ThingsBoard 微服务架构基于 Kafka 等消息基础设施进行节点间安全通信（架构文档含安全组件分层），平台支持多租户隔离 — [ThingsBoard PE 微服务文档](https://thingsboard.io/docs/pe/reference/architecture/microservices)（多租户为平台基本能力，具体 RBAC 粒度未在本次抓取范围内）

### Inferences
- 【推断】"软件侧合规"与"部署侧合规"要分开：软件能做的是（a）每个通信端点支持 TLS + 证书（含自签/企业 CA）（b）用户-角色-权限（RBAC）与操作审计日志（c）支持以边缘节点充当 conduit；（d）若目标市场有认证需求，参照 IEC 62443-4-1（安全开发生命周期）/4-2（组件要求）组织开发流程。IEC 62443-4-2 含用户管理与审计的组件要求（FR2/FR7 方向），但本次未抓取到标准原文（标准正文需付费），此句具体条款号为背景知识、置信度低——正式引用前需核对标准文本。
- 【推断】RBAC 与操作审计在本次搜索的公开资料中没有单列成文的"工业软件 RBAC 最佳实践"文章；但 Ignition/ThingsBoard 等产品均有角色权限与审计功能是行业事实（产品文档级证据未在本次逐条抓取，标注为 gap）。

### Gaps
- IEC 62443 标准正文（IEC 官方）付费，未获取原文；SL 等级与具体技术要求的逐条对应（如 SL2 对应何种认证强度）需购买标准或找权威解读补充。
- 工业软件 RBAC 模型（角色继承、操作双人复核/权限分段下装、电子签名如 FDA 21 CFR Part 11 类需求）与审计日志保留规范：未找到权威公开来源。
- 证书管理（OT 环境证书轮换、离线设备发证）公开资料少，仅 Keyfactor 等证书厂商有概览性内容。

## 技术栈对比：语言/框架、插件机制、Web 前端 vs 桌面

### Takeaway
行业现状是双主流：Windows 侧 C#/.NET（WinForms/WPF，现在 Avalonia 补齐跨平台）以开发效率与工具链胜出；跨平台/嵌入式 Linux 侧 C++/Qt（QML）是传统强项。同时"Web 化"已成明确方向：FUXA（Node.js + Angular）、ThingsBoard（Java 后端 + Angular 前端）、Ignition（Web 发布客户端）都把浏览器作为主界面。插件机制上，进程外隔离（Python 网关连接器、独立集成执行器）比进程内动态库更常见也更安全。

### Cited Findings
- 【事实·高】传统格局：Windows HMI 用 WinForms/WPF/C#，Linux 侧系统用 C++/Qt；Avalonia 使 .NET 具备跨平台工业 UI 能力，改变了这一分工 — [Avalonia 官方博客：工业与嵌入式 Linux GUI 跨平台](https://avaloniaui.net/blog/industrial-embedded-ui-dotnet)
- 【事实·高】Qt 官方将自身定位为"用 C++ 和 QML 构建工业软件的开发框架（面向 HMI/SCADA 开发，但本身不是成品 SCADA）" — [Qt in Automation 官方页](https://www.qt.io/development/qt-in-automation)
- 【事实·中】面向 MES/数据读取场景的实践文章指出 C#/.NET 生态有成熟的 PLC 通信库与 MES 对接惯例，是构建 SCADA/HMI 组件的常用选择 — [sviluppatoremigliore: SCADA, C# and .NET](https://sviluppatoremigliore.com/en/blog/scada-csharp-dotnet-what-is-and-how-it-works)
- 【事实·高】FUXA：开源 Web SCADA/HMI，技术栈 Node.js 后端 + Angular 前端，Docker 部署"数分钟可用"，浏览器即客户端、无需专用客户端软件；支持 Modbus、OPC UA、MQTT、BACnet、Siemens S7、WebSocket 连接 — [FUXA GitHub](https://github.com/frangoteam/fuxa)；[frangoteam.org](https://frangoteam.org)；[BrightCoding 介绍](https://prompts.brightcoding.dev/blog/stop-paying-thousands-for-scada-fuxa-is-the-open-secret-industrial-devs-love)
- 【事实·高】ThingsBoard：后端 Java（部分 Node.js 微服务），前端 Angular SPA — [PKE IoT Expert 架构概览](https://www.pke-iot.expert/docs/reference)；其 IoT Gateway 用 Python 实现且采用模块化、支持自定义扩展（连接器插件模型）— [ThingsBoard Gateway GitHub](https://github.com/thingsboard/thingsboard-gateway)
- 【事实·高】ThingsBoard PE 把外部系统集成（OPC-UA 等）放进独立微服务 Integration Executor 运行——即"集成代码进程外隔离"的工程范例 — [ThingsBoard PE 微服务文档](https://thingsboard.io/docs/pe/reference/architecture/microservices)
- 【事实·中】工业 HMI 开发语言对比（C/C++/C#/VB/Java）：C/C++ 常用于 PLC-设备协议通信等底层环节，C#/.NET 在上位机开发效率上占优 — [Industrial Monitor Direct 语言对比](https://industrialmonitordirect.com/es/blogs/knowledgebase/plc-hmi-programming-languages-c-c-c-vb-compared)；自研 .NET 与购买商业 SCADA 的决策指南见 [同站 build-or-buy 指南](https://industrialmonitordirect.com/blogs/knowledgebase/visual-studio-net-vs-scada-for-hmi-development-decision-guide)
- 【事实·低（背景知识，未逐条核实）】Eclipse SCADA（已更名 NeoSCADA，Eclipse 归档）为 Java/OSGi/Equinox 架构；OpenSCADA 为 Linux 体系的开源 SCADA。此信息来自搜索工具的摘要注记，未抓取原文页面，置信度低，使用前需核实 — 参见 [FUXA 搜索上下文](https://github.com/frangoteam/fuxa)
- 【事实·中】Ignition 的客户端为 Web 启动（零安装、任意设备、服务端统一推送更新）——Web/瘦客户端模式在商业 SCADA 中已是主流 — [Ignition 官方架构页](https://inductiveautomation.com/ignition/architectures)

### Inferences
- 【推断】四条技术路线的画像（基于以上事实的综合判断）：
  - C#/.NET + Avalonia：开发效率最高、上位机人才多、PLC 库生态成熟；跨平台已可用但工业现场惯例仍是 Windows 为主，Linux 运行时依赖自包含部署。适合团队以 Windows/微软栈为主。
  - C++/Qt：嵌入式/跨平台/性能上限最高，工控传统深厚；但开发效率低、内存安全风险自担、Qt 商业授权成本（见许可证节）。
  - Java：ThingsBoard 验证了大体量平台可行性，生态全；但内存占用对边缘小盒不友好，GUI 生态弱（前端必然另配 Web 栈）。
  - Node/TypeScript 全栈：FUXA 验证了"Web SCADA"可行性，前后端同语言、迭代最快；但 CPU 密集计算与硬实时弱、单进程可靠性需进程管理兜底。
  - Rust：本次搜索未找到成规模的工业 SCADA 编排系统案例作为参照（仅有库生态如 opcua/tokio 等，未在本次来源中确认），属于"技术上可行但行业先例少"的高风险选择。置信度低，为推断。
- 【推断】插件机制建议：南向协议插件用"进程外隔离"（独立进程 + IPC/本地总线，参照 ThingsBoard Gateway 连接器与 Integration Executor），胜过进程内动态库（崩溃传染、许可证边界、语言绑定复杂）；脚本层（给最终用户做逻辑编排，如类 Lua/JS 脚本）与协议插件层应分开设计。此为综合工程推断。
- 【推断】Web 前端（React/Vue + WebSocket）+ 本地服务 已被 Ignition（商业标杆）、FUXA（开源）、ThingsBoard（IoT 平台）三方共同验证为 2026 年默认形态；桌面单机方案仅在"完全离线单操作员站"场景还有理由。

### Gaps
- Rust 在工业控制/编排软件中的实际采用案例与评估文章未找到（搜索焦点被 C#/Qt 占据），无法给出有来源的结论。
- Avalonia 在真实工业产线长期运行的公开案例与维护性评价缺乏；Avalonia 官方博客属于厂商自述。
- "脚本引擎选型"（Lua vs JS vs Python 嵌入，及沙箱/超时控制）没有找到权威对比来源。
- 商业 SCADA 的 license 计价模式（按 tag 数/客户端数/服务器数）对自研产品定价的参考：Ignition 宣传"无限制客户端/tag"模式（官方架构页暗示），但未抓取到其定价页细节。

## MVP 建议：模块取舍与最易致命的架构决策

### Takeaway
从来源可归纳的 MVP 必备：南向 2–3 个主流协议（OPC UA + Modbus 是事实标配）、实时 tag 库与订阅推送、store-and-forward 断线缓存、Web 可视化、报警产生与确认、最小 RBAC 与审计。可以后补：双机热备、云端多租户、微服务化、复杂编排 DSL。最贵的返工点（做错代价最高）：tag 数据模型与命名空间设计、南向抽象层、以及许可证选择。

### Cited Findings
- 【事实·高】协议支持面的事实标配：FUXA 开箱支持 Modbus、OPC UA、MQTT、BACnet、S7、WebSocket — [FUXA GitHub](https://github.com/frangoteam/fuxa)；ThingsBoard Gateway 连接器覆盖 Modbus/OPC UA/BLE/MQTT 等 — [Gateway 文档](https://thingsboard.io/docs/iot-gateway)；OPC 基金会以 UA-EdgeTranslator 推动"万物翻译成 OPC UA" — [OPC Foundation GitHub](https://github.com/opcfoundation/ua-edgetranslator)
- 【事实·高】边缘能力清单（2026 年选型标准）把 store-and-forward、本地规则引擎、本地报警、断网自治列为平台必备 — [ANEXEE 2026](https://www.anexee.com/blog/industrial-edge-computing-gateway-platforms-2026)；[Harmony AI](https://www.tryharmony.ai/iiot-gateways)
- 【事实·高】Ignition 的演进路径参考：同一核心（Gateway）+ 模块化架构（Perspective/Reporting/Tag History 等模块化能力）+ 从单机到 Hub&Spoke/Enterprise 的渐进扩展 — [Ignition 官方架构页](https://inductiveautomation.com/ignition/architectures)
- 【事实·中】ThingsBoard 单体版可支撑约 2 万设备再考虑微服务化（社区实操）— [Reddit r/selfhosted](https://www.reddit.com/r/selfhosted/comments/1uezzao/switching_to_microservices_in_thingsboard)
- 【观点·高（工程共识）】冗余架构"转移而非消除故障点"，每种架构引入新故障模式——意味着冗余设计应晚于数据正确性设计 — [IT-ASP Dijital](https://it-aspdijital.com/en/blog/scada-redundancy-failover-basics)

### Inferences
- 【推断】MVP 模块清单（基于以上事实综合）：
  - 必备（v0.1）：南向 OPC UA 客户端 + Modbus 主站驱动框架；中心实时 tag 库（内存态 + 变化订阅推送）；报警引擎（产生/确认/流转）+ 事件存储；Web 仪表盘（WebSocket 实时推送）；用户/角色/审计；断线缓存与补传。
  - 后补（v0.2+）：双机热备（心跳/仲裁）、云边协同（MQTT 北向桥、多站点汇聚）、脚本编排/规则 DSL 高级特性、报表、多租户 SaaS。
- 【推断】最易"死"的三个环节（本次来源综合 + 工程推断）：
  1. tag 数据模型/命名空间设计（点类型、质量戳 quality、时间戳来源、死区/变化上报策略）一旦定型，贯穿采集-存储-报警-显示全线，返工代价最大；来源中 Ignition 的跨 Gateway tag 浏览/读写/历史查询均建立在其 tag 模型上（间接证据）。
  2. 南向驱动抽象层：协议差异（轮询 vs 订阅、地址模型、字节序、优化读写批处理）若抽象不当，每加一个协议都要改核心。
  3. 许可证/依赖选择：Qt 商业条款、TDengine AGPL、InfluxDB 3 OSS 功能边界（见下节），后期更换成本极高。
  以上为推断，置信度中。
- 【推断】"先单体后微服务"与 ThingsBoard 社区经验一致；MVP 不应上 K8s/微服务，但应在进程边界上为"协议驱动进程外隔离"预留设计（这样未来拆分成本低）。

### Gaps
- 未找到对"自研工业软件 MVP 失败案例/复盘"的公开系统性文章（HN/InfoQ 上以讨论帖为主，缺乏可引用的复盘数据）；"哪些环节最容易死"主要靠推断，标注置信度中。
- 缺少国内（知乎/InfoQ 中文）工业软件架构长文的可靠抓取结果——本次搜索以英文源为主，中文社区的工程经验（如组态软件、力控/亚控类产品的架构剖析）未能覆盖。

## 许可证风险：GPL 传染、Qt、OpenSSL、商用组件

### Takeaway
主要风险点：Qt 开源版为 GPL/LGPL 双许可（LGPL 合规复杂、LTS 更新仅商业版）；TDengine 为 AGPLv3（对闭源商用最激进）；TimescaleDB 部分企业功能非开源；OpenSSL 自 3.0（2021）起改为 Apache 2.0，历史 GPL 不兼容问题已基本消除（除 GPLv2-only）。商业组件的商业合同本身也有条款风险（Qt 商业协议被社区警告"不要原样签署"）。

### Cited Findings
- 【事实·高】Qt 官方开源义务页：说明 GPL/LGPL 义务及何时建议购买商业许可 — [Qt 官方：Obligations of the GPL and LGPL](https://www.qt.io/development/open-source-lgpl-obligations)
- 【事实·高】Qt LGPL 合规要点与争议：需动态链接并允许用户替换库，合规复杂；且 LTS 更新仅商业许可可得；论坛指出 LGPL 合规"没有司法判例"，Qt 官方答复可能有利己偏向 — [Stack Exchange 讨论](https://opensource.stackexchange.com/questions/15510/is-it-difficult-for-commercial-software-to-comply-with-qts-lgpl-license-terms-i)；[Qt Forum 讨论](https://forum.qt.io/topic/161555/using-qt-for-a-commercial-application-on-windows-lgpl/48?page=2)
- 【事实·高】"GPL 对商业产品基本不可行，因为要求完整源码公开"——GPL 传染性使闭源工业软件不能静态链接 Qt GPL 版 — [Direct Insight 博客](https://blogs.directinsight.co.uk/qt-lgpl-vs-commercial)；[Extenly: Qt Licensing 指南](https://extenly.com/2024/02/07/qt-licensing-gpl-vs-lgpl-vs-commercial-choosing-the-right-fit-for-you)
- 【事实·高】Hacker News 对 Qt 商业许可协议的条款风险警告（"Do Not Sign the Qt License Agreement Unchanged"）— [Hacker News 帖](https://news.ycombinator.com/item?id=41558799)；社区对 Qt 公司推动商业化的批评 — [TQCS: Qt vs Qt](https://www.tqcs.io/qtqt.html)；嵌入式社区对 LGPL v3 条款（如反tivo化）的顾虑 — [Reddit r/embedded](https://www.reddit.com/r/embedded/comments/gjkxrt/what_do_you_think_about_gpllgpl_v3_for_qt)
- 【事实·高】OpenSSL 3.0.0（2021-09）从旧 "OpenSSL License"（基于 Apache 1.0） relicensing 为 Apache 2.0，终结了 GPL 程序使用 OpenSSL 需要"特别例外条款"的时代 — [LWN.net](https://lwn.net/Articles/868536)；FSF 立场：Apache 2.0 与 GPLv3 兼容、与 GPLv2 不兼容 — [Apache.org GPL 兼容性说明](https://www.apache.org/licenses/GPL-compatibility.html)；因此 OpenSSL 3.x 可用于 GPLv3-or-later 项目，纯 GPLv2-only 仍不可（历史遗留项目注意）— [Hacker News 讨论](https://news.ycombinator.com/item?id=23345135)
- 【事实·高】时序库许可证：TDengine = AGPLv3（对闭源分发与网络服务使用均有强约束）；InfluxDB = MIT/Apache 2.0；TimescaleDB = Apache 2.0 + 部分功能非开源 Timescale License — [TDengine 官方对比表](https://tdengine.com/how-to-choose-the-best-time-series-database)
- 【事实·中】VictoriaMetrics 为开源（Apache 2.0 系）单二进制（其 GitHub 主仓库 license 为 Apache 2.0）——本次经第三方对比文章间接确认，未直接抓取其仓库 license 文件，置信度中 — 参见 [NovaAI 对比](https://novaaiops.com/blog/prometheus-vs-influxdb-vs-victoriametrics-2026)

### Inferences
- 【推断】对闭源商用工业软件的具体建议（综合以上事实）：
  - 避免 GPL/AGPL 组件进入主程序分发链：Qt 用 LGPL（严格动态链接、允许替换）或买商业许可；TDengine 若闭源商用需购买商业授权或以"独立进程 + 网络接口"方式隔离（AGPL 下网络接口调用仍有争议空间，需法务确认——此句为推断，非法律意见）。
  - Rust/Go/Java 生态大量 Apache-2.0/MIT 库，许可证摩擦总体小于 C++ 生态——这是技术栈选型中常被低估的因素。
  - 商业组件（Qt 商业、KEPServerEX 类 OPC 商业驱动等）除许可费外注意合同条款（审计、续费涨价、部署限制），HN 的 Qt 合同警告是先例。
- 【推断】"进程外隔离 + 明确的网络协议边界"同时缓解三件事：插件崩溃隔离（可靠性）、GPL/AGPL 传染边界（许可证）、以及独立升级（运维）——这是把许可证风险转化为架构决策的少数抓手之一。

### Gaps
- 未获取 Qt 商业许可的具体价格与条款细节（需直接询价）；也未覆盖其他商用 OPC 驱动 SDK（如 Kepware、Matrikon）的许可模式。
- AGPL 下"SaaS 化部署是否触发开源义务"在中国/欧盟/美国不同法域的执行差异：无权威来源，需法律意见。
- GPL 类脚手架代码（如 Qt 的 meta-object 生成代码 moc 输出）是否构成衍生作品：无判例，论坛观点分歧（见 Stack Exchange 帖），标注为未决问题。

## 跨节汇总：对从零构建"多协议接入 + 逻辑编排"软件的架构决策素材（供报告写作者取用）

### Takeaway
综合全部来源：以"同一核心运行时（服务进程 + 实时 tag 库 + 规则/编排引擎）+ 进程外隔离的南向驱动框架 + MQTT 北向 + Web 客户端"为骨架，边缘/工控机/云端只是同一产物的三种打包；数据层用自研内存 tag 库 + 嵌入成熟 TSDB（Postgres 系选 TimescaleDB、边缘低资源选 VictoriaMetrics）；可靠性先做进程自愈 + 断线缓存，热备与冗余二期；安全按 IEC 62443 zones/conduits 设计软件能力（TLS+证书、RBAC、审计、边缘即 conduit）；技术栈按团队基因在 C#/.NET(+Avalonia) 与 Node/TS 之间取舍、Qt 需算入商业许可成本；许可证在选型第一天就要过一遍（Qt GPL/LGPL、TDengine AGPL、GPLv2-only 项目对 OpenSSL 的残余限制）。

### Cited Findings
（本节为跨节综合，事实出处见上各节对应链接；无新增独立来源。）

### Inferences
- 【推断】整体形态上最接近"可抄作业"的两个开源参照系：FUXA（Node.js + Angular 的轻量 Web SCADA，多协议、Docker 化，适合 MVP 骨架参照）与 ThingsBoard（Java 微服务平台 + Python 网关 + Edge，适合中大型分层参照）；商业标杆 Ignition（Web 发布、模块化、Edge 到云同构）用于产品形态对标。
- 【推断】2026 年语境下三个趋势性判断（基于来源综合，置信度中）：(1) Web/浏览器客户端全面取代专用桌面客户端；(2) MQTT 成为北向事实标准、OPC UA 翻译成为南向收敛方向（OPC 基金会 UA-EdgeTranslator）；(3) 时序库竞争焦点从"写入性能"转向"资源效率 + SQL 生态 + 边缘云同步"（TDengine 官方与 VictoriaMetrics 第三方基准均以此为主题）。

### Gaps
- 中文社区（知乎/InfoQ 中文）的工业软件架构深度实践文章未能可靠覆盖；国产工控生态（组态王、力控、SupOS 等）架构资料缺失。
- 未做真实 POC 级性能验证：本笔记所有性能数字均来自公开基准（部分为厂商自述），报告引用时应保留"供应商自述"标注。
