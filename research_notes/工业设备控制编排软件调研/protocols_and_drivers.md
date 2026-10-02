# 工业设备通信协议全景与统一驱动层架构设计（截至 2026 年）

> 研究日期：2026-10-02。本笔记面向"从零构建支持多种通信类型的设备控制软件"的协议层/驱动层架构决策。
> 标注约定：【事实】= 有来源引用；【观点】= 来源或本人的判断性陈述；【推断】= 基于事实的推理；置信度标注在未逐字核验的条目上。

---

## KQ1：各协议核心特征、典型场景与坑（Modbus、OPC UA/DA、MQTT/Sparkplug B、BACnet、CANopen、EtherNet/IP、Profinet、EtherCAT、DNP3、IEC 104/61850、裸串口/TCP/UDP）

### Takeaway
协议选择遵循三层规律：现场实时控制层由 PLC 厂商生态决定（Siemens→Profinet、Rockwell→EtherNet/IP、高动态运动→EtherCAT）；监控/采集层以 Modbus RTU/TCP 为最大公约数；垂直整合到 IT/云层以 OPC UA（Client/Server + PubSub）与 MQTT/Sparkplug B 为主流。电力行业另有两套专规（DNP3 北美、IEC 60870-5-104/61850 中欧），楼宇行业用 BACnet。新软件应把"协议栈"与"驱动框架"分离：实时总线一般不做自研主站，而是通过网关/PLC 间接接入，自己直面的是 Modbus、OPC UA、MQTT、裸串口这类"软实时"协议。

### Cited Findings

**总体格局与分层**
- 【事实】Modbus 是实现面最广的协议；Profinet 与 EtherNet/IP 分别主导各自控制器/设备生态（Siemens vs Rockwell/ODVA），选择通常跟随 PLC 品牌而非纯技术比较 — [plcprogramming.io 2026 协议指南](https://plcprogramming.io/pillar/communication-protocols)、[TSL Automation 对比文](https://www.tslautomation.com/blog/industrial-ethernet-protocols-compared)
- 【事实】通用工程指导：简单现场设备用 Modbus，实时控制用 Profinet/EtherNet/IP（跟 PLC 厂商走），垂直数据交换到 SCADA/MES/IT 用 OPC UA — [nexumautomatics 对比](https://nexumautomatics.com/en/blog/modbus-profinet-opc-ua-comparativa)
- 【事实】OPC/OPC UA 可用的自动化产品装机量超过 4500 万（OPC Foundation 口径，2025）— [IndustryX 引 OPC Foundation](https://industryx.ai/2025/12/10/opc-ua-manufacturing-connectivity-guide)（注：该数字为基金会宣传口径，属厂商联盟数据，置信度中）

**Modbus RTU/TCP/ASCII**
- 【事实】Modbus PDU 采用 0 基编址：0x0000 对应人读的 40001（保持寄存器），协议帧地址 = 面板地址 − 1；四类数据表前缀 0x/1x/3x/4x — [Orange Horse Tech](https://orangehorsetech.com/open-source/oms-modbus/modbus-register-addressing)、[Teracom](https://www.teracomsystems.com/blog/modbus-rtu-addressing-function-codes-register-spaces)、[ScadaProtocols](https://scadaprotocols.com/modbus-register-map-explained)
- 【事实】字节序是仅次于编址的第二大 Modbus 集成错误来源；调试技巧：写 100（0x0064），读回 25600（0x6400）即字节序反了；32 位值还存在字交换（word swap）问题 — [Chipkin](https://docs.chipin.com/articles/modbus-data-types-byte-order-reference)、[IOTech](https://iotechsystems.my.site.com/edgexpert/s/article/Byte-and-Word-Swapping-in-Modbus)、[Industrial Monitor Direct](https://industrialmonitordirect.com/blogs/knowledgebase/modbus-addressing-register-maps-offsets-and-master-requests)
- 【事实】Modbus TCP 运行在标准 TCP/IP 上，响应时间随网络负载变化（约 1–100 ms），无实时保证，适合 SCADA 数据采集与非时间敏感监控 — [TSL Automation](https://www.tslautomation.com/blog/industrial-ethernet-protocols-compared)
- 【推断·高置信度·训练知识】Modbus RTU 为 RS-485 主从半双工、无内建认证/加密、单请求-单响应的严格锁步协议；ASCII 帧模式因效率低（每字节 2 字符）已很少用于新产品，仅遗留兼容。未逐一核验原始规范（modbus.org），但与上述多个二手来源一致。

**OPC UA 与遗留 OPC DA**
- 【事实】OPC UA 语义丰富、内建安全，是 IT/OT 集成标准；不是硬实时（PubSub 改善了这点）— [TSL/Reddit 综述](https://www.tslautomation.com/blog/industrial-ethernet-protocols-compared)、[nexumautomatics](https://nexumautomatics.com/en/blog/modbus-profinet-opc-ua-comparativa)
- 【事实】OPC DA 基于 COM/DCOM，完全绑定 Windows、无法跨平台，这是迁移 UA 的核心动因 — [E&I Sales](https://eandisales.com/uncategorized/opc-da-vs-opc-ua)
- 【事实】微软 DCOM 加固（CVE-2021-26414 / KB5004442）2023-03-14 起强制不可禁用，导致大量远程 OPC Classic DA 连接断裂，修复靠注册表调整、改代码调用 RpcBindingSetAuthInfo() 或迁 UA — [Software Toolbox](https://softwaretoolbox.com/migration/legacy-top-top-server-to-neuron)、[OPC Foundation 论坛](https://opcfoundation.org/forum/classic-opc-da-ae-hda-xml-da-etc/opc-da-failed-to-connect-after-windows-dcom-server-security-feature-enable)、[Industrial Monitor Direct](https://industrialmonitordirect.com/blogs/knowledgebase/resolving-microsoft-dcom-hardening-impact-on-opc-da)
- 【事实】OPC UA FX（Field eXchange）把 OPC UA 从垂直整合延伸到实时现场层，依赖 TSN、Ethernet-APL、5G；B&R 称完全一致性测试过的 FX 产品预计 2025 年内出现 — [B&R](https://www.br-automation.com/en-us/technologies/opc-ua-fx)、[IndustrialEthernet.net](https://industrialethernet.net/technology/edge-cloud/opc-ua-fx-the-future-of-industrial-communication-is-taking-shape)
- 【事实】工业 TSN 配置文件标准 IEC/IEEE 60802 已于 2025 年发布；OPC Foundation 与 Avnu Alliance 在测试/认证上合作 — [技术指南](https://iotdigitaltwinplm.com/opc-ua-protocol-complete-technical-guide)、[Computer Automation](https://www.computer-automation.de/industrial-communication/cooperation-the-opc-foundation-and-avnu-are-collaborating.htm)
- 【观点·推断】FX/TSN 处于"从试点/规范走向初期商用"阶段（2025–2026），2026 年做架构决策时不应把 FX 当作现场层前提，但应预留 PubSub 能力。市场规模预测类数据（如 $15.87B）来自单一市场研究机构，置信度低，不作为依据 — [Future Market Insights](https://www.futuremarketinsights.com/reports/opc-ua-fx-market)

**MQTT / Sparkplug B**
- 【事实】Sparkplug 规范现行为 3.0.0；核心机制：Edge Node/Device 上线发 NBIRTH/DBIRTH 证书，死亡证书 NDEATH/DDEATH 通过 MQTT Last Will 预注册在 broker；Primary Host 应用在 `spBv1.0/STATE/{host}` 主题发 HBIRTH/HDEATH；消息为 Protobuf 编码，解决"晚加入者(late joiner)"与状态感知问题 — [Sparkplug 3.0.0 规范 PDF](https://sparkplug.eclipse.org/specification/version/3.0/documents/sparkplug-specification-3.0.0.pdf)、[Software Toolbox](https://softwaretoolbox.com/resources/what-is-sparkplug-b)、[PulseMQ](https://pulsemq.com/insights/what-is-sparkplug-b.html)、[Opto 22 白皮书](https://www.opto22.com/articles/industrial-strength-mqtt-sparkplug-b)
- 【事实】Sparkplug 主题命名空间 + 结构化 payload 让数据自描述；Host 应用收到 Primary Host 状态变化可触发数据"rebirth"重发 — [FlowFuse 实施指南](https://flowfuse.com/blog/2024/08/using-mqtt-sparkplugb-with-node-red)、[Fabrico](https://www.fabrico.io/blog/sparkplug-b-explained)
- 【推断·高置信度·训练知识】MQTT 本身是推送模型、QoS 0/1/2，无内建数据模型；对"主动轮询 + 写控制"的设备控制软件，MQTT/Sparkplug 是南北向数据总线而非设备驱动协议——写命令与按需读通常仍要走 Modbus/OPC UA 等通道。此为领域共识，来源见 Software Toolbox/Opto 22 对 Sparkplug 定位的描述。

**BACnet**
- 【事实】BACnet 为楼宇自动化协议（ASHRAE 135），协议本身无版税与许可限制，Vendor ID 注册免费；开源 C 协议栈 bacnet-stack 覆盖应用层/网络层/MAC 通信 — [bacnet-stack GitHub](https://github.com/bacnet-stack)、[SourceForge](https://bacnet.sourceforge.net)
- 【事实】Rust 生态出现原生实现 bacnet-stack-rs 与 BACnet-RS（后者目标 ANSI/ASHRAE 135-2024）；Elixir 有 Apache 2.0 的 bacstack — [bacnet-stack-rs](https://github.com/bacnet-stack/bacnet-stack-rs)、[BACnet-RS](https://github.com/bacnet-rs/bacnet-rs)、[bacstack](https://github.com/bacnet-ex/bacstack)
- 【推断·高置信度·训练知识】BACnet 设备模型以"对象-属性-服务"（AI/AO/BI/BO 等对象类型）为核心，支持 COV（变更值订阅）与 ReadPropertyMultiple 批读；楼宇场景独有 BACnet/IP 与 MS/TP 串口两种主流传输。除非做楼宇/暖通，一般工业控制软件可不做原生 BACnet。

**CANopen**
- 【事实】CANopenNode 是 Apache 2.0 的开源 CANopen 协议栈（C，可移植），CANopenLinux 提供 Linux/SocketCAN 支持；Python 的 canopen 库实现 SDO/PDO/NMT，需 Python 3.9+，可用 python-can 作为硬件后端（SocketCAN、Kvaser、PCAN 等） — [CANopenNode](https://github.com/CANopenNode/CANopenNode)、[CANopenLinux](https://github.com/CANopenNode/CANopenLinux)、[canopen-python/canopen](https://github.com/canopen-python/canopen)、[hardbyte/python-can](https://github.com/hardbyte/python-can)
- 【推断·高置信度·训练知识】CANopen 核心概念：对象字典（OD，EDA 文件描述）、SDO（点对点参数读写，慢）、PDO（过程数据周期/事件映射，快）、NMT 状态机（master 管理 node 状态）；典型用于伺服、传感器、电池管理系统（BMS）、医疗设备内部总线。周期典型 1–10 ms 级。

**EtherNet/IP（CIP）**
- 【事实】EtherNet/IP 基于 CIP，Rockwell/Omron 生态，典型周期约 10 ms 级（500 µs–10 ms 区间，软实时） — [TSL Automation](https://www.tslautomation.com/blog/industrial-ethernet-protocols-compared)
- 【事实】开源侧：OpENer 是 EIPStackGroup 出品的 EtherNet/IP I/O adapter（设备侧）栈，免版税开源，支持多 I/O 与显式连接；Python 侧 pycomm3 面向 Allen-Bradley PLC 标签读写（client 角色），cpppo 支持 scanner/originator 与 adapter/responder 双角色 — [OpENer GitHub](https://github.com/EIPStackGroup/OpENer)、[automation.com](https://www.automation.com/article/free-open-source-ethernetip-communication-stack)、[pycomm3](https://github.com/ottowayi/pycomm3)、[cpppo PyPI](https://pypi.org/project/cpppo)
- 【事实】OpENer 曾被 Claroty Team82 模糊测试发现漏洞——用开源栈要跟进安全更新 — [EIPStackGroup/OpENer 检索结果注记](https://github.com/EIPStackGroup/OpENer)（置信度中：漏洞细节未单独核验）

**Profinet**
- 【事实】Profinet RT 约 1–10 ms 周期、IRT 可达 250 µs（运动控制硬实时）；是 Siemens S7/TIA Portal 生态的自然选择 — [TSL Automation](https://www.tslautomation.com/blog/industrial-ethernet-protocols-compared)
- 【事实】开源侧只有设备侧栈 p-net（rt-labs，C，符合 Profinet v2.4 CC A/B、RT Class 1，跑裸机/RTOS/Linux），GPLv3 双许可（商业需付费），公开仓库是评估版；Profinet 产品化无论栈如何许可，一般还要求加入 PROFIBUS/PROFINET International 会员与一致性测试 — [p-net GitHub](https://github.com/rtlabs-com/p-net)、[p-net LICENSE](https://github.com/rtlabs-com/p-net/blob/public/LICENSE.md)
- 【推断·高置信度·训练知识】开源世界基本没有可商用的 Profinet 控制器（scanner/主站）栈；PC 侧做 Profinet 主站通常买商业栈（如 Softing、hilscher、netX 硬件）或让 PLC 做主站。这与搜索结果（只有 device 栈开源）一致。

**EtherCAT**
- 【事实】EtherCAT 周期低至 31.25 µs、"processing on the fly"（从站在帧经过时读写数据），抖动 <1 µs，属硬实时，适合多轴伺服与高速运动 — [TSL Automation](https://www.tslautomation.com/blog/industrial-ethernet-protocols-compared)
- 【事实】开源主站：SOEM（Simple Open EtherCAT Master）为 GPLv2/GPLv3 + 链接例外（可闭源链接）+ 商业双许可，用户态库；IgH EtherCAT Master（EtherLab）更成熟、内核模块架构、GPLv2/LGPLv2.1 无链接例外（闭源产品需开源或商业授权）；Rust 的 EtherCrab 是新兴选择 — [SOEM LICENSE](https://github.com/OpenEtherCATsociety/SOEM/blob/master/LICENSE.md)、[acontis 对比](https://www.acontis.com/en/ethercat-master-options-ec-master-vs-open-source-etherlab-SOEM.html)、[ethercatcpp 文档](https://ethercatcpp.lirmm.net/ethercatcpp-framework/pages/available_ethercat_lib.html)、[Antoine Perrin 博客](https://antoineperrin.fr/en/blog/choosing-an-open-source-ethercat-master)、[RT-Labs](https://rt-labs.com/ethercat/choosing-the-right-ethercat-master-dedicated-plc-vs-software-based-solution)

**DNP3 与 IEC 60870-5-104 / IEC 61850（电力/SCADA 专规）**
- 【事实】DNP3 主用于北美电力/水务，IEC 60870-5-104 主用于中欧/亚欧电力（二者同为 SCADA 主从遥测/遥信/遥控协议）；开源实现：OpenDNP3（Step Function I/O，github.com/stepfunc/dnp3）与 lib60870（MZ Automation，IEC 101 串口 + 104 TCP）、Java 的 j60870（OpenMUC，client/server 均支持） — [scadaprotocols.com 对比](https://scadaprotocols.com/dnp3-vs-iec-60870-5-104)、[lib60870 GitHub](https://github.com/mz-automation/lib60870)、[j60870](https://www.openmuc.org/iec-60870-5-104)、[MZ Automation GitHub](https://github.com/mz-automation)
- 【事实】libIEC61850（MZ Automation）最新版本 1.6.2，含安全、稳定性与协议处理改进；另有 .NET 版 — [libiec61850.com](https://libiec61850.com)、[MZ Automation GitHub](https://github.com/mz-automation)
- 【推断·高置信度·训练知识】104 与 DNP3 都有时间戳报告、突发（unsolicited/spontaneous）上报、总召唤（general interrogation）机制；IEC 61850 面向变电站，核心是 MMS + GOOSE + SV，GOOSE/SV 直接走以太网二层、要求 ms 级确定性。除非目标客户是电力行业，否则这些协议放插件清单最后。

**裸串口/TCP/UDP 自定义帧**
- 【事实】TCP 转 RS-485 透明网关多路复用会造成串口侧碰撞：单一从站超时可能引发驱动断开整个 TCP 连接（Ignition 论坛实测案例） — [Inductive Automation 论坛](https://forum.inductiveautomation.com/t/modbus-rtu-over-tcp-single-slave-timeout-causes-driver-to-drop-entire-tcp-connection-failuretype-disconnected/115707)、[PLCTalk](https://www.plctalk.net/forums/threads/intermittent-timeouts-when-bridging-rs-485-modbus-rtu-to-tcp-ip-buffer-or-timing-issue.148965)
- 【推断·高置信度·训练知识+工程实践】自定义帧协议（厂商私有 ASCII/HEX 协议）是设备控制软件最常见接入方式：TCP 流式协议必须自行处理"粘包/半包"（用长度字段/定界符/超时三种策略之一），UDP 需处理乱序与丢包；驱动框架必须允许"帧编解码器"插件化（定义起始符、长度、校验、转义规则）。此为通用工程共识，无单一权威来源，置信度高。

### Inferences
- 协议矩阵可按两个轴切分：**确定性轴**（EtherCAT/Profinet IRT 硬实时 → Profinet RT/EtherNet/IP 软实时 → Modbus/MQTT/OPC UA CS 非确定）与**数据模型轴**（无模型裸寄存器 Modbus → 自描述 OPC UA/Sparkplug/61850）。驱动层的抽象必须同时覆盖这两个轴（见 KQ3）。
- 硬实时总线（EtherCAT、Profinet IRT、61850 GOOSE）不建议纳入自研统一驱动框架的一等公民：它们需要专用网卡调度/内核实时补丁甚至专用 ASIC，通常由 PLC/专用主站承担，统一框架经 OPC UA/Modbus 网关间接读取其数据即可。
- 2026 年立项的新软件，"OPC UA Client + Modbus RTU/TCP + MQTT/Sparkplug B + 裸串口/TCP 自定义帧 + （可选）DNP3/104"是覆盖 90% 场景的最小集；BACnet、CANopen、EtherNet/IP、Profinet 按行业订单再扩。
- 开源栈许可证必须作为选型硬约束：SOEM/p-net 是"GPL+商业"双许可，libmodbus LGPLv2.1（动态链接可用闭源，嵌入需商用授权约 750€），open62541/CANopenNode/OpENer/node-opcua/python-can(MIT 等) 商用友好。

### Gaps
- 各开源库的精确 GitHub star 数与最近 commit 日期未逐一核验（搜索快照只给了区间，如 node-opcua 约 1.5k+、libmodbus 约 3k+）；写报告引用活跃度时建议按仓库名链接而非具体数字。
- OpENer 的具体 CVE 编号与修复版本未核验。
- Sparkplug 3.0.0 相对 2.2 的具体差异（如 metric 类型扩展）未展开，只确认了版本现状。
- IEC 61850 GOOSE/SV 在 Linux 用户态的可行性与开源实现细节（libIEC61850 是否含 GOOSE publisher/subscriber 的实时性说明）未深入核验。

---

## KQ2：各协议的成熟开源库（语言、许可证、活跃度）

### Takeaway
主流协议都有可商用起点：Modbus→libmodbus（C/LGPL）、OPC UA→open62541（C/MPL2.0）或 node-opcua（TS/MIT）或 Python asyncua、MQTT→Eclipse Paho（多语言/EPL+BSD）、CAN→python-can+canopen（Python）、CANopen 嵌入式→CANopenNode（C/Apache2.0）、EtherCAT 主站→SOEM（双许可）或 EtherCrab（Rust）、DNP3→OpenDNP3（stepfunc）、IEC 104→lib60870、61850→libIEC61850、BACnet→bacnet-stack（C）。需要警惕许可证（GPL 双许可、LGPL 静态链接）与"设备侧有开源、主站侧无开源"（Profinet/EtherNet/IP）的不对称。

### Cited Findings

| 协议 | 库 | 语言 | 许可证 | 活跃度/备注 | 来源 |
|---|---|---|---|---|---|
| Modbus RTU/TCP/ASCII | libmodbus | C | LGPLv2.1+（商用嵌入授权 promodbus 约 750€） | 长期维护，官方 libmodbus.org | [GitHub](https://github.com/stephane/libmodbus)、[libmodbus.org](https://libmodbus.org) |
| OPC UA | open62541 | C99（兼容 C++98） | MPL-2.0（文件级弱 copyleft，可闭源组合） | v1.5 系列已到 v1.5.8 维护版；Fraunhofer IOSB 支持并有专业支持 | [GitHub Releases](https://github.com/open62541/open62541/releases)、[open62541.org](https://open62541.org) |
| OPC UA | node-opcua | TypeScript/Node | MIT | 生产级，用于 Mercedes-Benz、Renault、Siemens；Sterfive 提供商业支持；近期版本加强 HSM/云 KMS 私钥 | [GitHub](https://github.com/node-opcua/node-opcua)、[官网](https://node-opcua.github.io) |
| MQTT 3/5 | Eclipse Paho | C/C++/Java/Python/JS/Go 等 | EPL + EDL(BSD) 双许可 | Eclipse 官方，事实标准客户端；Python 版 paho-mqtt 支持 5.0/3.1.1/3.1 | [eclipse.dev/paho](https://eclipse.dev/paho)、[paho.mqtt.java](https://github.com/eclipse-paho/paho.mqtt.java)、[PyPI](https://pypi.org/project/paho-mqtt) |
| BACnet | bacnet-stack | C | 开源（SourceForge/GitHub 社区） | 应用层+网络层+MAC；BACnet 本身无版税 | [GitHub org](https://github.com/bacnet-stack)、[SourceForge](https://bacnet.sourceforge.net) |
| CAN（硬件抽象） | python-can | Python | LGPL | 支持 SocketCAN/Kvaser/PCAN 等多后端 | [GitHub](https://github.com/hardbyte/python-can) |
| CANopen | canopen（python） | Python | MIT/BSD（宽松） | SDO/PDO/NMT；需 Python 3.9+；以 python-can 为后端 | [GitHub](https://github.com/canopen-python/canopen) |
| CANopen（嵌入式） | CANopenNode / CANopenLinux | C | Apache-2.0 | 可移植；Linux 用 SocketCAN | [GitHub](https://github.com/CANopenNode/CANopenNode)、[CANopenLinux](https://github.com/CANopenNode/CANopenLinux) |
| EtherCAT 主站 | SOEM | C | GPLv2(+链接例外)/GPLv3 + 商业双许可 | 用户态，嵌入式/闭源商用友好 | [LICENSE.md](https://github.com/OpenEtherCATsociety/SOEM/blob/master/LICENSE.md)、[acontis](https://www.acontis.com/en/ethercat-master-options-ec-master-vs-open-source-etherlab-SOEM.html) |
| EtherCAT 主站 | IgH EtherCAT Master (EtherLab) | C | GPLv2/LGPLv2.1（无链接例外） | 最成熟开源主站；Linux 内核模块架构，集成难 | [ethercatcpp 文档](https://ethercatcpp.lirmm.net/ethercatcpp-framework/pages/available_ethercat_lib.html) |
| EtherCAT 主站 | EtherCrab | Rust | （新兴，具体许可证未核验） | 社区关注度上升 | [Antoine Perrin](https://antoineperrin.fr/en/blog/choosing-an-open-source-ethercat-master) |
| EtherNet/IP 设备侧 | OpENer | C | 免版税开源（EIPStackGroup） | adapter（I/O 从站）角色；有已披露安全漏洞史 | [GitHub](https://github.com/EIPStackGroup/OpENer)、[automation.com](https://www.automation.com/article/free-open-source-ethernetip-communication-stack) |
| EtherNet/IP 客户端 | pycomm3 / cpppo | Python | 开源（具体未核验） | pycomm3=AB PLC 标签读写 client；cpppo 可做 scanner/originator | [pycomm3](https://github.com/ottowayi/pycomm3)、[cpppo](https://pypi.org/project/cpppo) |
| Profinet 设备侧 | p-net | C | GPLv3 + 商业双许可（公开仓库为评估版） | 符合 v2.4 CC A/B、RT Class 1；裸机/RTOS/Linux | [GitHub](https://github.com/rtlabs-com/p-net) |
| DNP3 | OpenDNP3（stepfunc/dnp3，另有 Rust 版） | C++/Rust | Apache 系（未逐字核验） | 开源 SCADA 栈标准配置 | [stepfunc GitHub（经检索确认存在，未直接核验许可证文件）](https://github.com/stepfunc/dnp3) |
| IEC 60870-5-101/104 | lib60870 | C | 开源（GPL 系；MZ Automation 同时卖商业授权，未逐字核验） | 101 串口链路层 + 104 TCP；另有 .NET 版 | [GitHub](https://github.com/mz-automation/lib60870)、[libiec61850.com](https://libiec61850.com) |
| IEC 60870-5-104 | j60870 | Java | 开源（OpenMUC 项目） | client/server 均支持 | [OpenMUC](https://www.openmuc.org/iec-60870-5-104) |
| IEC 61850 | libIEC61850 | C | 开源（GPL 系 + 商业授权，同 MZ Automation） | v1.6.2，安全/稳定性更新 | [libiec61850.com](https://libiec61850.com)、[GitHub](https://github.com/mz-automation) |
| 多协议参考 | dscsys 协议网关项目 | — | — | 单项目覆盖 DNP3/104/61850/ICCP/Modbus/OPC UA/DA/MQTT-Sparkplug，可作架构参考 | [dscsys.com](https://dscsys.com/protocols.html) |

- 【事实】Python 生态另有 pylogix、snap7（S7）、asyncua 等 PLC 通信库横向对比可用 — [Industrial Monitor Direct 对比](https://industrialmonitordirect.com/blogs/knowledgebase/python-plc-communication-libraries-pylogix-pycomm3-snap7-comparison)

### Inferences
- 按许可证分三档做选型门槛：**免顾虑**（MIT/Apache/MPL：node-opcua、CANopenNode、open62541、OpENer）；**动态链接可用**（LGPL/EPL：libmodbus、python-can、Paho）；**闭源商用要付费**（SOEM/p-net/IgH/lib60870/libIEC61850 的双许可模式）。若框架本身闭源发布，第三档的库只能以独立进程/独立模块接入或购买授权。
- "C 核心库 + 语言绑定"是普遍形态（libmodbus、open62541、lib60870、bacnet-stack 都是 C）；用 Go/Rust/Java 重写协议栈不划算，围绕 C 库做 FFI/子进程封装更稳。
- 一个值得抄的开源参考是 dscsys 那类"单进程多驱动网关"项目结构（一个仓库并列多种协议驱动），可作为驱动插件 API 的现实样例。

### Gaps
- OpenDNP3、lib60870/libIEC61850 的确切许可证文本与最新版本号未逐字核验（MZ Automation 的商业授权模式为训练知识+官网间接印证，置信度中）；落地前必须读仓库 LICENSE。
- EtherCrab 的具体许可证与成熟度未核验。
- 各库 2026 年的提交频率/最近发布日期未逐一验证，活跃度结论基于"是否仍在发维护版"的间接证据。

---

## KQ3：统一驱动框架如何设计（点位模型、读写策略、扫描率分组、连接管理、插件接口：进程内 vs 进程隔离）

### Takeaway
行业标杆（Kepware/Ignition）的共识架构是：**Channel→Device→Tag 三级模型 + 驱动插件统一接口 + 服务端内部按扫描率轮询 + 对上层 OPC/订阅客户端做变化推送**。自研框架的关键决策是：统一 Tag 地址语法（协议相关部分留在驱动内）、按扫描率分组调度、内部轮询与上层订阅解耦、每设备独立连接状态机（重连退避），以及插件采用"进程内接口 + 崩溃隔离可选进程外"的混合模式。

### Cited Findings

**Kepware（KEPServerEX）模式**
- 【事实】KEPServerEX 采用 Channel→Device→Tag 配置模型；160+ 驱动是即插即用模块，单一用户界面提供一致访问；驱动以 DLL 形式被服务运行时加载，驱动目录下存在多个版本的驱动 DLL — [KEPServerEX v6 手册](https://www.opcturkey.com/uploads/kepserverex-v6-manual.pdf)、[KEPServerEX 手册](https://vertix.pe/wp-content/uploads/2022/09/kepserverex-manual.pdf)、[ATS Global PDF](https://www.ats-global.com/wp-content/uploads/2023/10/Driver-Options-for-KEPServerEX.pdf)、[Industrial Monitor Direct 技术参考](https://industrialmonitordirect.com/blogs/knowledgebase/kepserverex-technical-reference-architecture-drivers-opc-ua)
- 【事实】轮询发生在驱动内部（设备扫描率），OPC UA 客户端位于其上层、仅在数据变化时收到更新 — [Allied Solutions](https://www.alliedsolutionsglobal.com/en/news/configure-kepware-scan-rate-reliable-data)、[Industrial Monitor Direct](https://industrialmonitordirect.com/blogs/knowledgebase/how-do-you-configure-the-kepware-opc-ua-tag-scan-rate)
- 【事实】扫描模式可配置为"Request All Data at Scan Rate"（强制按指定速率扫描，范围 10–99,999,990 ms）或按客户端订阅驱动（respect client-influenced）；社区经验：订阅模式下客户端会覆盖扫描率，可靠性优先时用前者 — [PTC 官方文档：Device Properties—Scan Mode](https://support.ptc.com/help/kepware/drivers/en/kepware/drivers/OPCUACLIENT/Device_Properties_Scan_Mode_OPC.html)、[Reddit r/PLC](https://www.reddit.com/r/PLC/comments/1fw90ku/kepware_scan_rate)
- 【事实】另有 Demand Poll 模式：由客户端应用完全控制设备何时被轮询（适合某些 SCADA 架构）；客户端最快可请求 10 ms 更新率，且设备轮询与客户端更新运行在不同线程 — [PTC：Device Demand Poll](https://support.ptc.com/help/kepware/kepware_server/en/kepware/server/device-demand-poll.html)、[OPC Foundation 论坛](https://opcfoundation.org/forum/classic-opc-da-ae-hda-xml-da-etc/kepserver-data-scan-time)
- 【事实】第三方驱动开发历史上靠 Kepware "Driver Toolkit"，如今转向 Universal Device Driver（UDD）+ Profile Library 插件（用配置档案而非写代码接入新协议） — [PTC：Profile Library Architecture](https://support.ptc.com/help/kepware/features/en/kepware/features/profilelibrary/Architecture.html)
- 【事实】数据在驱动插件内采集后可传给 IoT Gateway 等上层插件（如转发 MQTT/Sparkplug） — [PTC：IoT Gateway 架构摘要](https://support.ptc.com/help/kepware/features/en/kepware/features/IOTGATEWAY/Architectural_Summary.html)

**Ignition 模式**
- 【事实】7.x 时代用 Scan Class（Tag Provider 内按扫描类执行标签，典型系统有多个 scan class + 多个 Tag Provider）；8.x 起改为 Tag Group + 基于 OPC UA 订阅（monitored items）而非轮询扫描类 — [Ignition 7.9 手册](https://www.docs.inductiveautomation.com/docs/7.9/tags/scan-classes)、[Ignition 8.3 手册：OPC UA Connections](https://www.docs.inductiveautomation.com/docs/8.3/ignition-modules/opc-ua/opc-ua-connections)、[Inductive University](https://inductiveuniversity.com/video/opc-ua-stand-alone-architecture/7.7)
- 【事实】scan class 是网关级调度对象，决定 OPC DA/UA 服务器发起读请求的频率（面向最大速度的配置实践） — [Industrial Monitor Direct](https://industrialmonitordirect.com/blogs/knowledgebase/configuring-ignition-scan-class-for-maximum-opc-tag-speed)
- 【事实】Ignition 可通过 OPC UA "expose tag provider" 把内部标签树再发布给外部，实现 10 万级标签的高效读取（OPC UA + MQTT 通道） — [Industrial Monitor Direct](https://industrialmonitordirect.com/blogs/knowledgebase/reading-100k-ignition-tags-efficiently-with-opc-ua-and-mqtt)

**框架设计要素（综合）**
- 【事实·综合推断】标签/点位模型的共识要素：唯一 ID、显示名、数据类型（含质量戳 quality/timestamp 的一等公民地位）、原始地址（协议私有语法，如 Modbus `4x00001` 或 `HR1`、OPC UA NodeId、Allen-Bradley `Controller.MyTag`）、扫描组、死区/变化上报阈值、读写权限 — 依据：Kepware Tag/Device/Channel 模型与 Ignition Tag Group 概念（上引 PTC/Inductive 文档）及 Modbus 编址文献（KQ1）
- 【推断】扫描率分组的正确形态是"相同周期的 tags 合并成组、组内再做协议级优化"：Modbus 临近寄存器合并为尽量少的 FC3 批读（受单帧 125 寄存器上限约束——训练知识，置信度高）；OPC UA 直接映射为 monitored items 订阅而非轮询（Ignition 8.x 的演进证明这一点）。
- 【推断】断线重连：每设备连接状态机（Connected/Reconnecting/Degraded/Failed）+ 指数退避 + 全量重同步（OPC UA 重建订阅、Sparkplug 触发 rebirth、Modbus 重新验证关键寄存器）；串口多设备共享一条物理链路时必须串行化所有请求（单队列），任一从站超时只标记该从站 degraded、不得拖垮整条链路——由"单从站超时导致整条 TCP 连接被断开"的反面案例支撑 — [Ignition 论坛案例](https://forum.inductiveautomation.com/t/modbus-rtu-over-tcp-single-slave-timeout-causes-driver-to-drop-entire-tcp-connection-failuretype-disconnected/115707)
- 【推断】连接池：Modbus TCP 对同一 IP:port 通常需要连接池或单连接串行复用（多数设备只支持少量并发 socket——训练知识，置信度中高）；OPC UA 单 session 内多 subscription 复用一条安全通道。
- 【推断】插件接口"进程内 vs 进程隔离"的权衡：Kepware 用进程内 DLL（性能好、160+ 驱动证明可扩展，但驱动崩溃即服务崩溃）；现代替代是驱动作为独立进程 + gRPC/IPC + 崩溃自动重启（隔离性好、便于多语言驱动与许可证隔离——GPL 库独立进程可规避链接传染）。混合建议：核心协议进程内、长尾/不稳/GPL 协议进程外。此为架构推断，非单一来源结论。

### Inferences
- 自研框架的推荐分层：`TagCore（类型/质量/时间戳）` → `ScanGroup Scheduler（按周期分组、合并请求）` → `Driver SPI（连接生命周期 read/write/batch/subscribe 四原语）` → `协议适配器（薄封装开源库）`。四原语中 subscribe 是可选能力位（轮询协议退化为 read 周期模拟）。
- 数据类型映射是跨协议统一的最大坑：Modbus 的 16 位寄存器 + 任意字节/字序 vs OPC UA 的强类型 vs Sparkplug 的 Protobuf metric 类型；点位定义必须显式携带（类型、字节序、字序、缩放、单位），并允许"原始值→工程值"换算（斜率/偏移、枚举映射）。
- Kepware 的 UDD+Profile 方向（配置档案代替写驱动代码）提示：对海量长尾私有串口协议，做"可配置帧描述引擎"（模板化请求/响应/校验）比逐个写驱动更省力。
- 写路径（控制命令）与读路径（采集）应分离：写要支持立即执行（bypass 扫描队列）、写确认与失败回读验证；控制类软件还应支持互斥写/写优先级。

### Gaps
- Kepware 驱动 DLL 的内部接口规范（Driver Toolkit 细节）未获公开文档，进程内插件接口细节只能从行为反推。
- Ignition 8.x Tag Group 的精确参数集（mode: fixed/subscribed、rate 上限）未逐页核验，只确认了概念替代关系。
- 未找到开源的"统一驱动框架"标准/规范类文献（类似 OPC UA 的信息模型那样的权威抽象），框架设计部分主要是"从 Kepware/Ignition 行为归纳"，置信度标注为推断。

---

## KQ4：实时性分级：毫秒级硬实时 vs 秒级软实时

### Takeaway
分级清晰可量化：EtherCAT（低至 31.25 µs，抖动 <1 µs）与 Profinet IRT（250 µs）是硬实时，需要专用栈与实时环境（内核模块/RTOS/专用硬件）；Profinet RT（1–10 ms）、EtherNet/IP（约 10 ms 级，500 µs–10 ms）是软实时；Modbus TCP（1–100 ms，随负载波动）、OPC UA CS、MQTT、BACnet、DNP3/104 是秒级/百毫秒级软实时，标准 IT 栈即可。统一设备控制软件的驱动层一般只瞄准后两档；硬实时层交给 PLC/专用主站，经网关数据交换。

### Cited Findings
- 【事实】周期时间对比：EtherCAT 31.25 µs（硬实时，processing-on-the-fly，抖动 <1 µs）；Profinet IRT 250 µs（硬实时）、RT 1 ms（约 1–10 ms）；EtherNet/IP 500 µs–10 ms（软实时）；Modbus TCP 1–100 ms（非确定） — [TSL Automation 对比](https://www.tslautomation.com/blog/industrial-ethernet-protocols-compared)
- 【事实】协议选择跟随生态：EtherCAT 适合高轴数伺服/高速拾放；Profinet 是 Siemens S7+TIA 自然选择；EtherNet/IP 关联 Rockwell/Omron — [TSL Automation](https://www.tslautomation.com/blog/industrial-ethernet-protocols-compared)
- 【事实】OPC UA 本体不是硬实时；PubSub+TSN 是其走向实时的路径 — [nexumautomatics](https://nexumautomatics.com/en/blog/modbus-profinet-opc-ua-comparativa)、[ABB 关于 FX 的说明](https://www.abb.com/global/en/company/innovation/news/opc-ua-fx-secure-industrial-connectivity)
- 【事实】IgH 主站绑定 Linux 内核模块以获得内核级实时性能；SOEM 为用户态库（配合 RT 调度可获得硬实时，但普通 Linux 用户态不可保证） — [ethercatcpp 文档](https://ethercatcpp.lirmm.net/ethercatcpp-framework/pages/available_ethercat_lib.html)、[acontis 对比](https://www.acontis.com/en/ethercat-master-options-ec-master-vs-open-source-etherlab-SOEM.html)、[RT-Labs](https://rt-labs.com/ethercat/choosing-the-right-ethercat-master-dedicated-plc-vs-software-based-solution)
- 【事实】Kepware 系扫描率下限 10 ms（10–99,999,990 ms），客户端最快 10 ms——这是商业 SCADA 软件对"软实时采集"的现实基线 — [PTC Scan Mode](https://support.ptc.com/help/kepware/drivers/en/kepware/drivers/OPCUACLIENT/Device_Properties_Scan_Mode_OPC.html)、[OPC Foundation 论坛](https://opcfoundation.org/forum/classic-opc-da-ae-hda-xml-da-etc/kepserver-data-scan-time)
- 【推断·高置信度·训练知识】CANopen PDO 周期典型 1–10 ms（CAN 500 kbps–1 Mbps 总线）；IEC 61850 GOOSE 要求 ≤4 ms 传输（变电站标准口径，未逐一核验条款号，置信度高）。

### Inferences
- 为本项目给出三档实用分级：**A 硬实时（<1 ms，确定性抖动）**：EtherCAT、Profinet IRT、61850 GOOSE/SV——不自研，买栈/用 PLC；**B 软实时控制（1–50 ms）**：Profinet RT、EtherNet/IP CIP I/O、CANopen、Modbus RTU 小网段——统一框架可承担但扫描率调度器要精确（10 ms 级、抖动控制）；**C 采集/监控（100 ms–分钟级）**：Modbus TCP、OPC UA、MQTT/Sparkplug、BACnet、DNP3/104、自定义帧——统一框架主战场。
- 框架的调度器设计以 10 ms 为最小扫描周期（与 Kepware 一致），并对 B 档设备提供"独占线程 + 优先级"选项。
- 普通 Linux 上做 B 档以上确定性需要 PREEMPT_RT 或 isolcpus/亲和性绑核；用户态 SOEM 在非 RT 内核上抖动不可控。

### Gaps
- Profinet RT/IRT 在具体负载下的实测抖动分布数据未找到权威公开测量。
- IEC 61850 GOOSE 4 ms 指标的标准条款出处未核验。

---

## KQ5：工程坑：串口半双工、超时重试、TCP 粘包、设备假死、字节序/编址

### Takeaway
工程坑集中在物理层（RS-485 半双工时序、终端电阻、极性）、协议时序（周转延时、T3.5 帧间隔、超时/重试策略）、语义层（0/1 基编址、字节/字序）和系统层（网关多路复用、DCOM、驱动崩溃）四层。防御性设计要点：请求队列串行化、指数退避重连、按设备粒度隔离故障、字节序显式配置 + 已知值自检。

### Cited Findings
- 【事实】RS-485 半双工核心问题：主站发完请求必须尽快释放发送驱动，否则从站响应被阻断/损坏；多数设备需要 3–5 ms 周转（turnaround），个别遗留设备需要高达 20 ms；超时调优要考虑字节级超时（byte-timeout）而非只看帧超时 — [MachineCDN 2026](https://www.machinecdn.com/blog/2026/03/04/modbus-rtu-serial-link-diagnostics-timeout-tuning)、[FlowFuse 2026](https://flowfuse.com/blog/2026/04/diagnosing-modbus-degradation)
- 【事实】多主/网关场景的 RS-485 碰撞与"A/B 极性接反、120 Ω 终端电阻缺失或错位、波特率不一致"等物理层根因；终端电阻装在廉价/故障驱动器上反而可能拉垮总线（社区疑难案例） — [Valtoris](https://valtoris.com/solving-rs485-collisions-multi-master)、[Industrial Monitor Direct](https://industrialmonitordirect.com/blogs/knowledgebase/modbus-timeout-error-troubleshooting-rs-485-wiring-issues)、[Reddit r/embedded](https://www.reddit.com/r/embedded/comments/1t2qtqw/rs485modbus_rtu_ghost_timeouts_losing_my_mind_here)
- 【事实】重试/超时逻辑必须考虑帧间静默（Modbus T3.5 字符间隔），不能只按字节超时处理 — [MachineCDN](https://www.machinecdn.com/blog/2026/03/04/modbus-rtu-serial-link-diagnostics-timeout-tuning)
- 【事实】TCP↔RS-485 透明网关多路复用会引发串口侧碰撞；实测案例：单个从站超时导致驱动断开整个 TCP 连接（Ignition Modbus RTU-over-TCP 案例）；网关桥接出现"正常数小时后随机掉线"的缓冲/时序问题 — [Ignition 论坛](https://forum.inductiveautomation.com/t/modbus-rtu-over-tcp-single-slave-timeout-causes-driver-to-drop-entire-tcp-connection-failuretype-disconnected/115707)、[PLCTalk](https://www.plctalk.net/forums/threads/intermittent-timeouts-when-bridging-rs-485-modbus-rtu-to-tcp-ip-buffer-or-timing-issue.148965)
- 【事实】Modbus 编址 off-by-one：面板 40001 → 协议 0x0000（需减一）；字节序为第二大错误源；已知值自检法（写 100 读回 25600 = 字节序反）；32 位值另有字交换 — [Orange Horse Tech](https://orangehorsetech.com/open-source/oms-modbus/modbus-register-addressing)、[Chipkin](https://docs.chipin.com/articles/modbus-data-types-byte-order-reference)、[Industrial Monitor Direct 调试法](https://industrialmonitordirect.com/blogs/knowledgebase/modbus-addressing-register-maps-offsets-and-master-requests)、[Reddit r/PLC](https://www.reddit.com/r/PLC/comments/rfllc6/why_do_i_need_to_deduct_1_from_modbus_register)
- 【事实】OPC DA/DCOM 加固 2023-03 起强制，远程 DA 连接大面积断裂（Windows 专用、注册表/代码级 workaround） — [Software Toolbox](https://softwaretoolbox.com/migration/legacy-top-server-to-neuron)、[Industrial Monitor Direct](https://industrialmonitordirect.com/blogs/knowledgebase/resolving-microsoft-dcom-hardening-impact-on-opc-da)
- 【推断·高置信度·训练知识+工程实践】设备假死（device hang）：现场设备偶发不响应但 TCP 连接仍 ESTABLISHED——TCP keepalive 周期默认太长（小时级）不能用于设备探测，必须用应用层请求超时判活 + 主动断开重连；"写后回读验证"是对付假写成功的标准手段。TCP 粘包对自定义协议必须靠长度前缀/定界符/超时三分法在帧解码器解决（流式 socket 无消息边界是 socket API 语义）。此为通用工程共识。

### Inferences
- 驱动框架应内建的防御机制清单：①每链路请求串行队列（半双工天然约束）；②超时=帧超时+字节间超时双层；③重试带指数退避与上限，重试期间标记质量戳 BAD（不删上次好值）；④从站粒度故障隔离（一个坏从站不拖垮链路/连接）；⑤连接判活用应用层而非 TCP keepalive；⑥字节序/字序/0-1 基编址在点位配置显式声明并支持已知值自检工具。
- Modbus RTU-over-TCP 网关类设备应视为"半双工资源"建模（并发=1），与真 Modbus TCP（可并发）区分——两者不能共用连接策略。
- 质量戳（good/bad/uncertain）+ 时间戳必须贯穿缓存与上送，这是 SCADA 惯例（OPC UA StatusCode 的直接对应物），缺失会导致上层无法区分"值真的为 0"和"读失败"。

### Gaps
- Modbus T3.5（3.5 字符静默判帧）在不同波特率下的精确毫秒数（如 >19200 bps 时规范固定为 1.75 ms 的例外规则）未核验原始规范条款，置信度高但引用需查 modbus.org 原文。
- "设备假死但 TCP 存活"缺乏单一权威文献，属社区共识+论坛案例支持（上引 Ignition/PLCTalk 案例为邻近证据）。
- 未找到针对 TCP 粘包的工业标准文献（中文社区术语"粘包"在英文文献中对应 "stream framing/message boundaries"，一般散见于 socket 编程教程），处理策略按通用工程共识给出。

---

## 附：一页决策速查（供报告 writer 直接引用）

| 维度 | 推荐 |
|---|---|
| 必备协议集（2026 立项） | Modbus RTU/TCP、OPC UA Client（订阅+浏览）、MQTT(+Sparkplug B)、裸串口/TCP 自定义帧 |
| 行业扩展 | BACnet（楼宇）、CANopen（设备内总线）、DNP3/IEC 104/61850（电力）、EtherNet/IP client（Rockwell 场合） |
| 不自研、走网关/PLC | EtherCAT、Profinet RT/IRT、OPC UA FX/TSN（观察）、GOOSE/SV |
| 框架骨架 | Channel→Device→Tag（Kepware 式）+ Tag Group（Ignition 8 式）+ Driver SPI 四原语（connect/read/write(batch)/subscribe）|
| 最小扫描周期 | 10 ms（对齐 Kepware 下限） |
| 插件形态 | 核心协议进程内 + 长尾/GPL/不稳协议进程外（gRPC/IPC + 崩溃重启） |
| 点位模型必备字段 | 类型、地址（协议私有语法）、字节序/字序、缩放、扫描组、死区、质量戳、时间戳、读写权限 |

**主要来源索引**：[TSL Automation 协议对比](https://www.tslautomation.com/blog/industrial-ethernet-protocols-compared)、[PTC Kepware 文档](https://support.ptc.com/help/kepware/drivers/en/kepware/drivers/OPCUACLIENT/Device_Properties_Scan_Mode_OPC.html)、[Ignition 手册](https://www.docs.inductiveautomation.com/docs/8.3/ignition-modules/opc-ua/opc-ua-connections)、[Sparkplug 3.0.0 规范](https://sparkplug.eclipse.org/specification/version/3.0/documents/sparkplug-specification-3.0.0.pdf)、[open62541](https://github.com/open62541/open62541)、[libmodbus](https://github.com/stephane/libmodbus)、[SOEM LICENSE](https://github.com/OpenEtherCATsociety/SOEM/blob/master/LICENSE.md)、[p-net](https://github.com/rtlabs-com/p-net)、[OpENer](https://github.com/EIPStackGroup/OpENer)、[lib60870](https://github.com/mz-automation/lib60870)、[libIEC61850](https://libiec61850.com)、[bacnet-stack](https://github.com/bacnet-stack)、[python-can](https://github.com/hardbyte/python-can)、[CANopenNode](https://github.com/CANopenNode/CANopenNode)、[node-opcua](https://github.com/node-opcua/node-opcua)、[Eclipse Paho](https://eclipse.dev/paho)
