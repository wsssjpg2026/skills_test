# Orch — 工业设备控制与编排软件

开源（Apache-2.0）的工业设备控制与编排平台：统一标签（Tag）模型的南向驱动插件
（Modbus / OPC UA / MQTT-Sparkplug / HTTP / 帧模板）、可视化流程编排引擎
（任务队列、WAL 断点恢复、ISA-88 暂停/保持/停止/中止、Saga 补偿）、ISA-18.2
报警、RBAC 与审计、北向 MES / MQTT 集成，以及 Vite + React 的 Web 组态前端。

当前状态：**walking skeleton（工单 #2）** —— monorepo 骨架、CI 流水线、内核
健康检查与状态页就绪；驱动插件宿主、标签核心、编排引擎等随后续工单（#3 起）
逐步落地。规格与任务见 GitHub Issues（#1 为总规格）。

## 环境要求

- **Node.js ≥ 24**（npm ≥ 11，npm workspaces）
- docker / docker compose **可选**（仅用于 prod-like 一键栈；本地开发完全不需要）
- Python ≥ 3.9 仅在涉及 Python 插件 SDK（`sdk/python`）时需要

## 快速开始（方式一：嵌入式存储，默认，无任何外部依赖）

```bash
npm ci            # 安装全部 workspace 依赖（也是原生模块 prebuild 探针）
npm run build     # tsc -b（全部 TS 包）+ vite build（状态页）
npm start         # 启动内核：orch.config.json（默认嵌入式存储 ./data）
```

验证：

```bash
curl http://localhost:8080/health/live
curl http://localhost:8080/health/ready
# 浏览器打开状态页
open http://localhost:8080/
```

`/health/*` 响应（架构文档 §2.1）：

```json
{
  "status": "ok",
  "version": "0.1.0",
  "uptimeSec": 3,
  "storage": { "mode": "embedded", "ok": true },
  "plugins": []
}
```

配置文件路径可用 `ORCH_CONFIG` 覆盖（默认 `./orch.config.json`）；日志级别用
`ORCH_LOG_LEVEL`（默认 `info`，pino JSON 输出）。

## 快速开始（方式二：docker compose，可选 prod-like 栈）

在有 docker 的环境：

```bash
docker compose up          # kernel（嵌入式存储）+ timescale，状态页 http://localhost:8080/
# 加 MQTT broker（驱动开发用）：
docker compose --profile mqtt up
# 切换 kernel 到 Postgres 存储（storage-timescale 随 #9 落地）：
docker compose -f docker-compose.yml -f docker-compose.postgres.yml up
```

> 本仓库的本地开发与测试**不依赖 docker**；TimescaleDB 相关测试（vitest
> `db` project）仅在 CI 的 GitHub Actions service 或本地设置
> `POSTGRES_TEST_DSN` 时运行。

## 常用脚本

| 命令 | 说明 |
|---|---|
| `npm run build` | 构建全部 TS 包（tsc -b）+ 状态页（vite build） |
| `npm run typecheck` | 全量类型检查 |
| `npm run lint` | ESLint（flat config） |
| `npm test` | vitest `embedded` project（无需任何容器） |
| `npm run test:db` | vitest `db` project（需 `POSTGRES_TEST_DSN`；#9 填充） |
| `npm run dev` | 内核开发模式（tsx watch） |
| `npm run dev -w @orch/web` | 状态页开发模式（Vite，`/health` 代理到 8080） |
| `npm run license:check` | 依赖许可证检查（CI 同款） |

## 工程结构

```
packages/
├── kernel/             @orch/kernel           组合根 + 核心服务（REST/WS/标签核心/引擎）
├── plugin-host/        @orch/plugin-host      驱动插件宿主（子进程监管 + JSON-RPC）#3
├── contracts/          @orch/contracts        全部公共类型（API/WS/SPI/流程）零逻辑
├── storage/            @orch/storage          存储端口 + 嵌入式实现（SQLite/环形缓冲/JSONL）
├── storage-timescale/  @orch/storage-timescale  Postgres/Timescale 实现 #9
├── drivers/            南向驱动插件（进程隔离）
│   ├── modbus/ opcua/ mqtt/ http/ frame-template/
├── simulators/         仿真器（产品功能，非脚手架）
│   ├── mock-driver/ modbus-slave/ opcua-server/ mes/ robot/ galbot-fake/
├── testkit/            @orch/driver-testkit   SPI 合约测试套件 CLI（第三方准入）#3
├── testing/            @orch/testing          内核测试缝（bootKernel 等）#3+
└── web/                @orch/web              Vite + React 前端（状态页 → 监控/画布）
sdk/python/             orch-plugin-sdk        Python 插件 SDK（纯标准库）#19
plugins/                运行时插件清单（dev）
scenarios/              验收场景 fixtures（#15）
docker-compose.yml      可选 prod-like 本地栈
.github/workflows/      CI：build-test / db / license / contract
```

（标注 #N 的包/目录为对应工单落地内容，当前为可构建的最小 stub。）

## CI 与许可证纪律

- **build-test**：lint / typecheck / build / 嵌入式测试；`npm ci` 兼作原生模块
  （better-sqlite3、serialport）prebuild 探针。
- **db**：TimescaleDB service 容器 + vitest `db` project。
- **license**：license-checker-rseidelsohn 按包检查 —— MIT/ISC/BSD/Apache-2.0/
  MPL-2.0 全局允许；**EPL-2.0 仅允许出现在 `packages/drivers/mqtt`**
  （sparkplug-payload）；GPL/AGPL/UNKNOWN 一律红。内核依赖树内不得含 EPL。
- **contract**：驱动 SPI 合约套件（#3 前为占位）。

## 许可证

Apache-2.0。依赖许可证纪律见上文与 `scripts/license-check.sh`。
