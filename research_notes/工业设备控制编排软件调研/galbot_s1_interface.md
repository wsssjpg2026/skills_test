# 银河通用 Galbot S1 机器人开发者接口调研（截至 2026-10）

调研对象：Galbot S1（银河通用机器人，北京）。调研时间：2026-10-02。来源以官方开发者平台 developer.galbot.com、GitHub 组织 GalaxyGeneralRobotics、galbot.com 产品页为主，中文科技媒体为辅。所有"推断"均已与"有来源的事实"区分标注。

## KQ1: S1 是什么形态的机器人？官方名称与在售状态？

### Takeaway
Galbot S1 官方定位为"工业级具身智能重载机器人"（Industrial Heavy-Duty Robot），**不是全尺寸人形**，而是"轮式全向底盘 + 双 7 轴机械臂 + 升降立柱 + 2 自由度颈部"的轮式双臂构型。2026 年 1 月 21 日发布，已在宁德时代量产线常态化运行，官网有"立即购买"入口（京东），但售价未公开。

### Cited Findings
- 官方名称与形态：四舵轮全向底盘（730×730mm）+ 双 7 自由度臂（肩到腕 920mm）+ 2 自由度颈 + 750mm 行程升降立柱；整机最高 1793mm、重 320kg、最高速度 1.5m/s — [galbot.com/s1](http://www.galbot.com/s1/)
- 负载与作业空间：官网与媒体报道"双臂最大持续作业负载 50kg、作业高度覆盖地面至 2.3m 货架"；2×48V 30Ah 电池约 8 小时续航、2 小时充电、支持热插拔 — [galbot.com/s1](http://www.galbot.com/s1/)；[新浪财经发布报道](https://finance.sina.com.cn/stock/t/2026-01-19/doc-inhhuzkc7057525.shtml)
- 传感器与算力：NVIDIA Jetson AGX Orin 64GB（275 TOPS）；头部双目相机 + 3D LiDAR，胸部 2 深度相机 + 2 六维力传感器，底盘 2×3D LiDAR；7 寸触屏、WiFi 2.4/5G、蓝牙 5.2 — [galbot.com/s1](http://www.galbot.com/s1/)
- **数据冲突（须注意）**：官方快速使用手册规格表写 **15kg/单臂（双臂合计 30kg）**，而官网与媒体宣传为"双臂 50kg" — [S1 快速使用手册 2.0.0](http://developer.galbot.com/docs/s1/2.0.0/zh/s1/) vs [galbot.com/s1](http://www.galbot.com/s1/)。两者口径可能不同（持续作业负载 vs 峰值/协同搬运），未获官方澄清。
- 发布：2026 年 1 月 21 日发布，搭载"具身搬运模型"与自研具身多模态大模型 AstraBrain（银河星脑），纯视觉方案，宣传为"行业首个零遥操、全自主、可持续作业的重载机器人" — [新浪财经](https://finance.sina.com.cn/stock/t/2026-01-19/doc-inhhuzkc7057525.shtml)
- 商业化验证：与宁德时代（CATL）签署全球战略合作；2026 年 3 月在宁德 HX 基地完成验收后，S1 在量产线 7×24 小时连续运行 4 个月（截至 2026-07 报道） — [CATL 官网](https://www.catl.com/news/10053.html)；[新浪财经](https://finance.sina.com.cn/jjxw/2026-07-24/doc-iniixfyc4889761.shtml)
- 在售状态：官网"立即购买"按钮指向京东商品页（中国区可订购），未标价格；作为参考，同厂人形 G1 售价约 70 万元人民币 — [galbot.com/s1](http://www.galbot.com/s1/)；[36氪](https://m.36kr.com/p/3978672823417862)
- 公司背景：累计 6 轮融资约 70 亿元；2026 年 6 月完成 11 亿元新一轮融资，宁德时代战投及溥泉资本领投 — [南方都市报](https://m.mp.oeeee.com/a/BAAFRD0000202506231096913.html)；[36氪](https://m.36kr.com/p/3978672823417862)

### Inferences
- 对驱动设计而言，S1 应按"移动操纵平台（mobile manipulator）"建模：一个可导航的底盘 + 两条可独立规划的臂 + 升降立柱，而非人形步态机器人；"站点"概念（导航目标点）与"点位"概念（臂末端笛卡尔位姿）在 SDK 中是两套独立 API。
- 手册（30kg）与宣传（50kg）的负载差异不影响接口设计，但涉及产线节拍评估时应向厂商索取书面规格。

### Gaps
- S1 具体售价、交付周期未公开；须直接询价。
- 官网产品页未提 IP54，而媒体早期报道提到 IP54 防尘防水 —— 环境适应性指标以手册/合同为准（手册仅给出 0–40°C、0–90%RH）。

## KQ2: 官方对外接口有哪些（SDK 语言、HTTP/TCP、WebSocket、ROS2、数字IO/Modbus）？

### Takeaway
官方对外唯一公开的开发接口是 **Galbot SDK（Python + C++）**，运行在 Linux（Ubuntu 20.04–24.04）上，底层经 SDK 封装的 DDS 中间件与机器人本体上的服务进程通信。**没有公开的 HTTP/REST、WebSocket、Modbus 或数字 IO 控制接口**；ROS2 未作为对外 API 文档化（无公开的 topic/service/action 列表）。末端工具侧有一条 CAN/RS485 原始字节透传通道。

### Cited Findings
- SDK 官网与版本：Galbot SDK 自述为"面向银河通用系列机器人平台的统一二次开发工具包，封装底层硬件通信与算法"，支持 **C++ 和 Python**，当前版本 **V1.10.0（2026-09-22 发布）**，配套机器人环境 GBS 1.18，支持 Ubuntu 20.04–24.04、Python 3.8–3.14 — [SDK Overview (S1, 1.10.0)](https://developer.galbot.com/docs/SDK/1.10.0/s1/en/overview/)；[GitHub GalaxyGeneralRobotics/GalbotSDK](https://github.com/GalaxyGeneralRobotics/GalbotSDK)
- 通信底层（SDK 文档内的间接证据）：端工具原始数据走"共享 DDS topic"；运动规划经 RPC 服务（MPS，如 CombinePlanReq/MoveLineReq）；位姿经 TF 树查询；相机 H.264 视频流订阅 — [Python API Reference (S1, 1.10.0)](https://developer.galbot.com/docs/SDK/1.10.0/s1/en/api_python_reference/)
- 机器人侧后台服务进程示例：`/data/galbot/bin/service_navigation_plan`、`service_motion_plan`、`robot_state_publish`、`eyehand_calib_publish`、`service_lidar_capture`，教程要求这些服务已加载 — [SDK Tutorials (S1, 1.10.0)](https://developer.galbot.com/docs/SDK/1.10.0/s1/en/tutorials/)
- 消息格式风格：PointCloud2、CompressedImage（header/format/depth_scale）等 protobuf 风格消息 — [SDK Tutorials](https://developer.galbot.com/docs/SDK/1.10.0/s1/en/tutorials/)
- **无 HTTP/WebSocket API**：SDK 全部文档（Overview/示例/API Reference）中未出现任何 HTTP、REST、WebSocket 接口 — [文档索引](https://developer.galbot.com/docs/SDK/1.10.0/s1/en/)
- **ROS2 未对外文档化**：公开文档从不点名 ROS2 发行版，也未提供 topic/service/action 列表；SDK 用自家 DDS 封装层。生态暗示：官方开源了 [galbot_s1_description](https://github.com/GalaxyGeneralRobotics/galbot_s1_description)（URDF/MJCF/USD 三格式模型资产，Apache-2.0）和 [galbot-mcap2lerobot](https://github.com/GalaxyGeneralRobotics/galbot-mcap2lerobot)（MCAP 是 ROS2 标准录制格式，MIT）— [GitHub 组织仓库列表](https://github.com/orgs/GalaxyGeneralRobotics/repositories)
- 传统工业接口：**无 Modbus / 数字IO 控制接口的任何公开文档**。最接近的是"S1 Raw End-Tool Passthrough"：第三方 CAN/RS485 末端工具可经 64 字节原始 TIB 帧透传，SDK 提供 `send_endtool_raw_frame(side, frame)` 发送与 `register_endtool_raw_callback`（1kHz/250Hz 接收流）— [S1 SDK 文档目录](https://developer.galbot.com/docs/SDK/1.10.0/s1/en/)；[Python API Reference](https://developer.galbot.com/docs/SDK/1.10.0/s1/en/api_python_reference/)
- 硬件扩展口：机身 USB 3.0 ×2、以太网口；标配无线遥控器与无线急停 — [galbot.com/s1](http://www.galbot.com/s1/)；[S1 快速使用手册](http://developer.galbot.com/docs/s1/2.0.0/zh/s1/)
- SDK 部署方式（仓库脚本证据）：`install.sh`（依赖装入 `/opt/galbot/deps/`）、`deploy_to_robot.sh`、`check_robot_compat.py`、离线安装脚本；源码编译安装，未见 pip 发布 — [GitHub GalbotSDK](https://github.com/GalaxyGeneralRobotics/GalbotSDK)
- 开发者平台附加能力：浏览器内仿真、代码"从平台一键部署到真机"、AI 文档助手；平台采用订阅制定价（基础工具/场景套件/完整方案三层） — [developer.galbot.com 平台页](https://developer.galbot.com/docs/SDK/1.10.0/s1/en/installation/)（该 URL 实际渲染为开发者平台产品页）
- 产品线并列：文档站同时覆盖 G1（通用人形）、S1（工业重载）、TM01（遥操作主从臂），SDK 为同一框架 — [文档站导航](https://developer.galbot.com/docs/SDK/1.10.0/s1/en/)

### Inferences
- 对 TypeScript/Node 编排软件而言，**不存在可直接调用的 HTTP/WebSocket 接口**；现实路径是写一个薄的 Python（或 C++）"sidecar"进程运行 Galbot SDK，Node 内核通过本机 IPC（stdin/stdout、本地 socket 或自建小 HTTP 服务）与之交互——这与用户"专有 SDK 与开源内核进程隔离"的预设一致，也是官方架构（SDK ↔ DDS ↔ 机器人服务）的自然延伸。
- SDK 通信走 DDS，理论上支持跨网段部署（工作站开发 + 部署到机器人），仓库里的 `deploy_to_robot.sh` 表明官方预期是把代码部署到机器人本体运行；跨网远程直连的 DDS 域配置未见公开文档（见 Gaps）。
- URDF/MJCF/USD 资产 Apache-2.0 开源，意味着可以在开源项目里合法使用 S1 模型做仿真/可视化，不含控制接口。

### Gaps
- **ROS2 发行版与原生 topic/service/action 列表：不公开**（官方仅暴露 Python/C++ SDK 层）。若项目必须走 ROS2，需向厂商确认内部是否为 ROS2 及是否开放 DDS 域外接入。
- **HTTP/TCP/WebSocket 远程 API：不公开**（全文档未见）。
- **Modbus/数字IO：不公开**。机身以太网口能否挂 PLC 类网关无文档。
- SDK 能否从外部工作站经网络直连机器人（DDS 发现/网段要求）：公开安装文档细节未能抓取确认，需装机实测或问厂商。
- 京东在售 SKU/价格页面内容未核实。

## KQ3: 指令粒度——能否高层指令 + 完成回调？

### Takeaway
**可以发高层指令并同步得到完成/失败结果**：导航有 `navigate_to_goal()`（带 `is_blocking`/`timeout`，配 `check_goal_arrival()` 到达判定与 `ControlStatus`/`MotionStatus` 枚举），机械臂有 `set_end_effector_pose()`（阻塞/非阻塞+超时+状态枚举）。但"完成反馈"以**阻塞调用 + 状态轮询**为主，**没有 push 式任务事件回调**（仅视频流和端工具原始流有回调）。无公开的"扫码/预设任务"级原子 API；官方高层业务模块（分拣、料箱搬运）需商务授权。

### Cited Findings
- 官方三层能力划分：Basic（关节位置/轨迹、末端笛卡尔位姿、底盘开环速度、急停、传感器流）；Advanced（高频闭环接口、正逆解、单/多链运动规划+碰撞检查、障碍物管理、SLAM 导航含"精确导航任务下发与状态监控"）；Business（**SPS 分拣模块、料箱搬运模块——需联系商务授权**） — [SDK Overview](https://developer.galbot.com/docs/SDK/1.10.0/s1/en/overview/)
- 导航（GoTo 站点级）：`nav.navigate_to_goal(goal_pose, enable_collision_check=True, is_blocking=True, timeout=30)`；先 `nav.check_path_reachability(goal_pose, cur_pose)` 预检；完成后轮询 `nav.check_goal_arrival()` 判定到达；`nav.is_localized()` / `nav.relocalize()` 处理定位；`nav.get_current_pose()`、`local_pose_to_global()` 坐标变换 — [SDK Tutorials 示例 3](https://developer.galbot.com/docs/SDK/1.10.0/s1/en/tutorials/)
- 导航前置条件：必须先用 **Map Engine** 完成建图与定位，导航功能依赖地图引擎；需 `service_navigation_plan` 服务 — [SDK Tutorials](https://developer.galbot.com/docs/SDK/1.10.0/s1/en/tutorials/)
- 底盘精确移动：`robot.set_base_pose(...)` 三种重载（Pose / x-y-yaw+frame_id / x-y-yaw+插值时间），推荐 frame_id 用 `"rel(0)"` 相对坐标；另有 `set_base_velocity(v, w, duration_s)`、`stop_base()`、`get_odom()` — [Python API Reference](https://developer.galbot.com/docs/SDK/1.10.0/s1/en/api_python_reference/)
- 臂（move_to 点位级）：`motion.set_end_effector_pose(...)`（单链/带辅助链两种重载，阻塞或非阻塞+超时，支持法兰/TCP 坐标）；`motion.motion_plan(target, ...)` 高层单目标规划；`motion_plan_multi_waypoints()` 多路点/双臂同步；`combine_plan()` 串联多段轨迹 — [Python API Reference](https://developer.galbot.com/docs/SDK/1.10.0/s1/en/api_python_reference/)
- 完成/失败反馈机制：`is_blocking + timeout_s` 贯穿关节/底盘/夹爪/末端调用；`ControlStatus.SUCCESS` 与 `gm.MotionStatus` 枚举（SUCCESS / TIMEOUT / FAULT / INVALID_INPUT / IN_PROGRESS / STOPPED_UNREACHED / DATA_FETCH_FAILED / PUBLISH_FAIL / COMM_DISCONNECTED）；轨迹执行状态轮询 `check_trajectory_execution_status()` — [Python API Reference](https://developer.galbot.com/docs/SDK/1.10.0/s1/en/api_python_reference/)；[SDK Tutorials](https://developer.galbot.com/docs/SDK/1.10.0/s1/en/tutorials/)
- 夹爪：`set_gripper_command(end_effector, width_m, velocity_mps, effort, is_blocking)`、`get_gripper_state()`（含 is_moving） — [Python API Reference](https://developer.galbot.com/docs/SDK/1.10.0/s1/en/api_python_reference/)
- 回调类 API 仅限：`subscribe_video_data`（H.264 流）与 `register_endtool_raw_callback`（端工具原始流，1kHz/250Hz） — [Python API Reference](https://developer.galbot.com/docs/SDK/1.10.0/s1/en/api_python_reference/)
- 官方完整高层任务示例（教程 6）= 导航 + 感知 + 抓放的整段 Python 编排（导航到观测位 → 检测 → 抓取 → 放置），全部用上述原语拼装，非单一"任务"调用 — [SDK Tutorials 示例 6](https://developer.galbot.com/docs/SDK/1.10.0/s1/en/tutorials/)

### Inferences
- 用户的驱动形态（发 goto 站点 / move_to 点位 → 等完成/失败事件）与 SDK 能力吻合：sidecar 内以阻塞调用包装成"命令-结果"消息即可；"失败"语义可映射 `MotionStatus`/`ControlStatus` 的 TIMEOUT/FAULT/STOPPED_UNREACHED 等枚举。
- "等待完成事件"需由 sidecar 轮询或阻塞后上报，机器人不会主动 push 任务事件——驱动的事件模型要自己封装。
- "扫码动作"这类复合预设动作没有现成 API，需在 sidecar 内用（导航/移动臂 + 触发外设）组合实现；外设触发可用端工具 CAN/RS485 透传或机身 USB/以太网扩展口自行接扫码器。
- 站点（named goal）管理未见专门 API（教程用位姿计算），建图与站点标定是部署期人工/工具流程（Map Engine），驱动设计应把"站点表"放在编排层维护。

### Gaps
- Map Engine 建图/站点定义的具体操作与持久化格式：公开文档有"Routine Operations（例行操作，如地图引擎）"章节但本次未抓取全文；须装机后查阅。
- Business 层（SPS 分拣、料箱搬运）模块的确切 API、调用方式与授权费用：不公开，需联系商务。
- 夹爪之外的末端执行器（吸盘等）选型与 SDK 支持列表未在本次调研确认。

## KQ4: 开发者文档与示例代码在哪？有无任务/调度 API？

### Takeaway
官方文档站与开发者平台在 **developer.galbot.com**（中英双语，含浏览器仿真与一键部署真机），SDK 源码与示例在 **GitHub 组织 GalaxyGeneralRobotics/GalbotSDK**。无公开的多机器人任务/调度（fleet/调度器）API；最接近的是需商务授权的业务能力模块。

### Cited Findings
- 文档站结构（S1 SDK 1.10.0）：Overview / Download / Installation & Configuration / Tutorials（含 Routine Operations 如 Map Engine）/ S1 Raw End-Tool Passthrough / Python Examples / C++ Examples / Python API Reference / C++ API Reference / set_config 可配置字段参考 / Troubleshooting / License — [文档索引](https://developer.galbot.com/docs/SDK/1.10.0/s1/en/)
- 产品手册（区别于 SDK 文档）：S1 快速使用手册 2.0.0（免责声明、产品概述、规格、使用说明、网络配置、充电、保养、疑难解答、保修 12 个月） — [S1 手册](http://developer.galbot.com/docs/s1/2.0.0/zh/s1/)
- GitHub：[GalaxyGeneralRobotics](https://github.com/orgs/GalaxyGeneralRobotics/repositories) 组织共 17 个公开仓库：GalbotSDK（主 SDK）、GalbotSDKDeps（依赖）、galbot_s1_description 与 galbot_one_golf_description（URDF/MJCF/USD 模型）、galbot-mcap2lerobot（MIT）、以及多个研究论文官方实现（Humanoid-GPT、OpenWBT 等多为 Apache-2.0）
- SDK 仓库内自带可离线浏览的 docs（`docs/{model}/{zh|en}/index.html`）与 examples 目录 — [GitHub GalbotSDK](https://github.com/GalaxyGeneralRobotics/GalbotSDK)
- 开发者平台：文档中心、AI 助手、浏览器仿真、代码一键部署到真机；订阅制定价，三层产品（基础工具/场景套件/完整方案） — [developer.galbot.com](https://developer.galbot.com/docs/SDK/1.10.0/s1/en/installation/)（渲染为平台产品页）
- 支持渠道：support@galbot.com；技术文档、答疑群、培训与定制开发服务 — [SDK Overview](https://developer.galbot.com/docs/SDK/1.10.0/s1/en/overview/)
- 任务/调度 API：公开文档中**没有**多机调度、任务队列、订单系统类接口；高层任务能力即"Business 能力层"（SPS Sorting Module、Bin Handling Module），官方明确"需联系销售/商务获取授权" — [SDK Overview](https://developer.galbot.com/docs/SDK/1.10.0/s1/en/overview/)

### Inferences
- 用户的工业编排软件正好补位 Galbot 缺失的调度层：Galbot SDK 提供"单机能力原语"，编排/任务分发由上层软件负责——这与"首个机器人驱动只做高层指令+完成事件"的定位一致。
- 建议驱动研发时同步申请：开发者平台账号（含仿真）、GalbotSDK 仓库访问、Business 模块授权评估（若需要官方分拣/料箱能力）。

### Gaps
- 开发者社区/论坛：未见公开独立论坛，答疑走官方支持群（微信群类），内容不入公开索引。
- 调度系统（如与 MES/WMS 对接的方案）：可能有企业级私有方案，公开资料无。

## KQ5: 许可证——SDK 能否集成进 Apache-2.0 项目？

### Takeaway
**Galbot SDK 是专有（proprietary）许可，不能并入或再分发进 Apache-2.0 项目**。许可声明为 Galbot 机密信息，"仅可按与 Galbot 签订的许可协议使用，未授权的复制、使用、分发或衍生作品被严格禁止"。用户设想的"专有 SDK 与开源内核进程隔离"方向正确，但严格说连"分发 SDK 给最终用户"都受限，需在商务协议中明确交付形态。

### Cited Findings
- SDK 许可证原文要点（版权 2023–2026 Galbot, Inc.）："This software contains confidential and proprietary information of Galbot, Inc."；仅可按与 Galbot 签订的许可协议使用；"UNAUTHORIZED COPYING, USE, OR DISTRIBUTION OF THIS SOFTWARE, OR ANY PORTION OR DERIVATIVE THEREOF, IS STRICTLY PROHIBITED."；误收须立即通知并删除 — [SDK License 页](https://developer.galbot.com/docs/SDK/1.10.0/s1/en/license/)
- GitHub 上 GalbotSDK 仓库 license 标记为 "Other"（自定义专有许可），第三方组件许可放在仓库 `licenses/` 目录 — [GitHub GalbotSDK](https://github.com/GalaxyGeneralRobotics/GalbotSDK)
- 对照：模型资产仓库 galbot_s1_description 为 **Apache-2.0**（URDF/MJCF/USD 可自由用于开源项目）；多数研究仓库为 Apache-2.0，个别 MIT — [galbot_s1_description](https://github.com/GalaxyGeneralRobotics/galbot_s1_description)；[组织仓库列表](https://github.com/orgs/GalaxyGeneralRobotics/repositories)
- 商业分层：Business 能力模块（分拣/料箱）本身就要单独商务授权；开发者平台服务为订阅制 — [SDK Overview](https://developer.galbot.com/docs/SDK/1.10.0/s1/en/overview/)

### Inferences
- 开源内核（Apache-2.0）+ 闭源 sidecar（进程隔离，装机时由集成商/用户自行从 Galbot 获取 SDK 并编译）是唯一合规路径：开源仓库不 vendor SDK 代码、不在开源仓库中再分发 SDK 二进制，文档指引用户自行克隆 GalbotSDK；sidecar 与内核间用自定义 IPC 协议（该协议本身可开源）。
- 即便进程隔离，"向客户分发含 SDK 的整机软件包"仍可能触碰"禁止分发"条款——应在采购/合作谈判中向 Galbot 明确：集成商二次开发成果的分发权、SDK 随项目交付的方式（联系 support@galbot.com 或商务）。
- 模型/仿真资产（Apache-2.0）可安全用于驱动的仿真测试与 3D 可视化。

### Gaps
- 与 Galbot 签订的标准开发者协议具体条款（是否允许集成商向最终客户分发 sidecar+SDK 组合）：不公开，需向厂商索取。
- SDK 是否对单个机器人/站点数量授权（license server、机器指纹）：公开文档未见说明。

---

## 附：来源清单（主要）
- 官网产品页：https://www.galbot.com/s1
- 开发者平台文档（S1 SDK 1.10.0，中/英）：https://developer.galbot.com/docs/SDK/1.10.0/s1/en/
- S1 快速使用手册 2.0.0（中文）：http://developer.galbot.com/docs/s1/2.0.0/zh/s1/
- GitHub 组织：https://github.com/GalaxyGeneralRobotics （GalbotSDK、galbot_s1_description 等）
- 发布与商业化报道：[新浪财经 2026-01](https://finance.sina.com.cn/stock/t/2026-01-19/doc-inhhuzkc7057525.shtml)、[CATL 官网](https://www.catl.com/news/10053.html)、[新浪财经 2026-07](https://finance.sina.com.cn/jjxw/2026-07-24/doc-iniixfyc4889761.shtml)、[36氪](https://m.36kr.com/p/3978672823417862)、[南方都市报](https://m.mp.oeeee.com/a/BAAFRD0000202506231096913.html)
